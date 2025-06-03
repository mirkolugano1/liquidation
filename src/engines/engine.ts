//#region #Imports

import common from "../shared/common";
import _ from "lodash";
import encryption from "../managers/encryptionManager";
import sqlManager from "../managers/sqlManager";
import { ethers, formatUnits } from "ethers";
import Big from "big.js";
import logger from "../shared/logger";
import { InvocationContext } from "@azure/functions";
import { LoggingFramework } from "../shared/enums";
import Constants from "../shared/constants";
import { Alchemy, Network } from "alchemy-sdk";
import emailManager from "../managers/emailManager";
import axios from "axios";
import { c, r } from "tar";
import repo from "../shared/repo";
import liquidationManager from "../managers/liquidationManager";
import transactionManager from "../managers/transactionManager";
import moment from "moment";

//#endregion Imports

class Engine {
    //#region #Singleton definition

    private static instance: Engine;
    private constructor() {}

    public static getInstance(): Engine {
        if (!Engine.instance) {
            Engine.instance = new Engine();
        }
        return Engine.instance;
    }

    //#endregion Singleton definition

    //
    //
    //
    // space to allow regions to be displayed correctly in VSCode
    //
    //
    //

    //#region #Initialization methods

    //#region initializeWebServer

    async initializeWebServer() {
        if (repo.isWebServerInitialized) return;

        repo.ifaceBorrow = new ethers.Interface(
            Constants.ABIS.BORROW_EVENT_ABI
        );
        repo.ifaceDeposit = new ethers.Interface(
            Constants.ABIS.DEPOSIT_EVENT_ABI
        );
        repo.ifaceSupply = new ethers.Interface(
            Constants.ABIS.SUPPLY_EVENT_ABI
        );
        repo.ifaceWithdraw = new ethers.Interface(
            Constants.ABIS.WITHDRAW_EVENT_ABI
        );
        repo.ifaceLiquidationCall = new ethers.Interface(
            Constants.ABIS.LIQUIDATION_CALL_EVENT_ABI
        );
        repo.ifaceRepay = new ethers.Interface(Constants.ABIS.REPAY_EVENT_ABI);
        repo.ifaceFlashLoan = new ethers.Interface(
            Constants.ABIS.FLASHLOAN_EVENT_ABI
        );

        await this.initializeAlchemy();
        await this.initializeAddresses();
        await this.initializeReserves();
        await this.initializeGasPrice();
        await this.resetUsersReservesStatus();
        await this.initializeUsersReserves();

        console.log("Web server initialized");
        repo.isWebServerInitialized = true;
    }

    //#endregion initializeWebServer

    //#region initializeAddresses

    async initializeAddresses(network: Network | string | null = null) {
        if (!repo.aave) throw new Error("Aave object not initialized");
        const _key = network?.toString() ?? null;

        for (const aaveNetworkInfo of common.getNetworkInfos()) {
            const key = aaveNetworkInfo.network.toString();
            if (_key && key != _key) continue;

            const initAddresses = await sqlManager.execQuery(
                `SELECT * FROM addresses WHERE network = '${key}'`
            );
            for (const address of initAddresses) {
                if (!repo.aave[address.network].hasOwnProperty("addresses"))
                    repo.aave[address.network].addresses = [];
                repo.aave[address.network].addresses.push(address.address);

                if (
                    !repo.aave[address.network].hasOwnProperty(
                        "addressesObjects"
                    )
                )
                    repo.aave[address.network].addressesObjects = {};
                repo.aave[address.network].addressesObjects[address.address] =
                    address;
            }
        }
    }

    //#endregion initializeAddresses

    //#region initializeUsersReserves

    async initializeUsersReserves(network: Network | string | null = null) {
        if (!repo.aave) throw new Error("Aave object not initialized");
        const _key = network?.toString() ?? null;
        for (const aaveNetworkInfo of common.getNetworkInfos()) {
            const key = aaveNetworkInfo.network.toString();
            if (_key && key != _key) continue;
            let hasAddressesToBeLoaded = true;

            do {
                const queryAddresses = `SELECT TOP ${Constants.CHUNK_SIZE} address FROM addresses WHERE network = '${key}' AND status = 1`;
                const chunkAddresses = await sqlManager.execQuery(
                    queryAddresses
                );
                hasAddressesToBeLoaded = chunkAddresses.length > 0;
                const query = `SELECT * FROM usersReserves WHERE network = '${key}' AND address IN (${_.map(
                    chunkAddresses,
                    (o) => `'${o.address}'`
                ).join(",")})`;

                if (hasAddressesToBeLoaded) {
                    const dbUsersReserves = await sqlManager.execQuery(query);
                    if (dbUsersReserves.length > 0) {
                        let usersReserves: any = {};
                        const networkUsersReserves = _.filter(dbUsersReserves, {
                            network: key,
                        });
                        for (let networkUserReserves of networkUsersReserves) {
                            if (!usersReserves[networkUserReserves.address])
                                usersReserves[networkUserReserves.address] = {};
                            usersReserves[networkUserReserves.address][
                                networkUserReserves.tokenAddress
                            ] = networkUserReserves;
                        }
                        repo.aave[key] = _.assign(aaveNetworkInfo, {
                            usersReserves: usersReserves,
                        });

                        //calculate "external" collateral for all users in case of credit delegation in order to
                        // take it into account when receiving events from Alchemy
                        for (
                            let i = 0;
                            i < repo.aave[key].addresses.length;
                            i++
                        ) {
                            const address = repo.aave[key].addresses[i];
                            if (!repo.aave[key].usersReserves[address])
                                continue;
                            const userReserves =
                                repo.aave[key].usersReserves[address];
                            if (!userReserves || userReserves.length == 0)
                                continue;
                            const externalCollateral = _.reduce(
                                userReserves,
                                (
                                    total: number,
                                    userReserve: {
                                        currentATokenBalance: number;
                                    }
                                ) => {
                                    return (
                                        total +
                                        (userReserve.currentATokenBalance || 0)
                                    );
                                },
                                0
                            );

                            repo.aave[key].addressesObjects[
                                address
                            ].externalCollateral = externalCollateral;
                        }
                    }
                }

                const queryUpdate = `UPDATE addresses SET status = 2 WHERE network = '${key}' AND status = 1 AND address IN (${_.map(
                    chunkAddresses,
                    (o) => `'${o.address}'`
                ).join(",")})`;
                await sqlManager.execQuery(queryUpdate);
            } while (hasAddressesToBeLoaded);

            await logger.log(
                `initializeUsersReserves: Users reserves initialized for network ${key}`
            );
        }
    }

    //#endregion initializeUsersReserves

    //#region initializeReserves

    async initializeReserves(network: Network | string | null = null) {
        if (!repo.aave) throw new Error("Aave object not initialized");
        const _key = network?.toString() ?? null;

        let reserves: any = {};
        for (const aaveNetworkInfo of common.getNetworkInfos()) {
            const key = aaveNetworkInfo.network.toString();
            if (_key && key != _key) continue;

            const whereClause = _key ? ` WHERE network = '${_key}'` : "";
            let query = `SELECT * FROM reserves ${whereClause} ORDER BY sorting`;

            const dbReserves = await sqlManager.execQuery(query);
            if (!dbReserves || dbReserves.length == 0) {
                await logger.log(
                    "initializeReserves: No reserves found in DB. Please run the updateReservesData function first."
                );
                return;
            }

            const networkReserves = _.filter(dbReserves, { network: key });
            for (let networkReserve of networkReserves) {
                reserves[networkReserve.address] = networkReserve;
            }
            repo.aave[key].reserves = reserves;
        }
    }

    //#endregion initializeReserves

    //#region initializeGasPrice

    async initializeGasPrice(network: Network | string | null = null) {
        if (!repo.aave) throw new Error("Aave object not initialized");
        const key = network?.toString() ?? null;
        for (const aaveNetworkInfo of common.getNetworkInfos()) {
            if (network && key != aaveNetworkInfo.network.toString()) continue;
            const gasPrice = await aaveNetworkInfo.alchemy.core.getGasPrice();
            repo.aave[aaveNetworkInfo.network].gasPrice = gasPrice;
        }
    }

    //#endregion initializeGasPrice

    //#region initializeAlchemy

    async initializeAlchemy(network: Network | string | null = null) {
        if (repo.aave) return;
        repo.aave = {};

        this.webappUrl = await common.getAppSetting("WEBAPPURL");

        const alchemyKey = await encryption.getAndDecryptSecretFromKeyVault(
            "ALCHEMYKEYENCRYPTED"
        );

        if (!alchemyKey) {
            await logger.log(
                "initializeAlchemy: No Alchemy key found. Please set the ALCHEMYKEYENCRYPTED environment variable."
            );
            return;
        }

        for (const aaveNetworkInfo of common.getNetworkInfos()) {
            const key = aaveNetworkInfo.network.toString();
            if (network && key != network.toString()) continue;

            const config = {
                apiKey: alchemyKey, // Replace with your API key
                network: aaveNetworkInfo.network,
            };
            const alchemy = new Alchemy(config);
            const alchemyProvider = await alchemy.config.getProvider();
            const flashbotsProvider = new ethers.JsonRpcProvider(
                aaveNetworkInfo.flashbotsProviderUrl
            );

            let networkInfo: any = _.assign(aaveNetworkInfo, {
                alchemy: alchemy,
                alchemyProvider: alchemyProvider,
                flashbotsProvider: flashbotsProvider,
            });

            repo.aave[key] = networkInfo;

            if (!common.isProd && !networkInfo.isActive) continue;

            const addresses = await transactionManager.multicall(
                aaveNetworkInfo.aaveAddresses.poolAddressesProvider,
                null,
                Constants.ABIS.ADDRESSES_PROVIDER_ABI,
                ["getPoolDataProvider", "getPriceOracle", "getPool"],
                aaveNetworkInfo.network
            );

            if (!addresses) {
                await logger.log(
                    `initializeAlchemy: No addresses found for network ${aaveNetworkInfo.network.toString()}. Please check the Aave addresses provider.`
                );
                return;
            }

            networkInfo.aaveAddresses.poolDataProvider =
                addresses[0]?.toString();
            networkInfo.aaveAddresses.aaveOracle = addresses[1]?.toString();
            networkInfo.aaveAddresses.pool = addresses[2]?.toString();
        }
    }

    //#endregion initializeAlchemy

    //#endregion Initialization methods

    //#region #Variables

    triggerWebServerActionDevDisabled: boolean = true;
    webappUrl: string = "";

    //#endregion Variables

    //#region #Helper methods

    //
    //
    //
    // space to allow regions to be displayed correctly in VSCode
    //
    //
    //

    //#region updateUserConfiguration

    async updateUserConfiguration(
        addresses: string | string[],
        network: Network | string
    ) {
        if (!Array.isArray(addresses)) addresses = [addresses];
        const aaveNetworkInfo = common.getAaveNetworkInfo(network);
        const userConfigurations = await transactionManager.multicall(
            aaveNetworkInfo.aaveAddresses.pool,
            addresses,
            Constants.ABIS.POOL_ABI,
            "getUserConfiguration",
            aaveNetworkInfo.network
        );
        let ucQuery = `UPDATE addresses SET userConfiguration = CASE `;
        for (let i = 0; i < userConfigurations.length; i++) {
            const userAddress = addresses[i];
            const userConfiguration = new Big(userConfigurations[i])
                .toNumber()
                .toString(2);

            repo.aave[network].addressesObjects[userAddress].userConfiguration =
                userConfiguration;

            ucQuery += `WHEN address = '${userAddress}' THEN '${userConfiguration}' `;
        }
        ucQuery += `ELSE userConfiguration END WHERE address IN ('${addresses.join(
            "','"
        )}');`;
        await sqlManager.execQuery(ucQuery);
    }

    //#endregion updateUserConfiguration

    //#region updateUsersReservesData

    async updateUsersReservesData(
        userAddressesObjects: any[],
        aaveNetworkInfo: any
    ) {
        const key = aaveNetworkInfo.network.toString();

        let multicallUserReserveDataParameters: any[] = [];
        const reservesAddresses = _.keys(aaveNetworkInfo.reserves);

        //load usersreserves data for each user for each reserve
        for (let i = 0; i < userAddressesObjects.length; i++) {
            const userAddressObject = userAddressesObjects[i];

            for (let j = 0; j < reservesAddresses.length; j++) {
                const reserveAddress = reservesAddresses[j];
                multicallUserReserveDataParameters.push([
                    reserveAddress,
                    userAddressObject.address,
                ]);
            }
        }

        const results = await transactionManager.multicall(
            aaveNetworkInfo.aaveAddresses.poolDataProvider,
            multicallUserReserveDataParameters,
            Constants.ABIS.POOL_DATA_PROVIDER_ABI,
            "getUserReserveData",
            aaveNetworkInfo.network
        );

        let sqlQueries: string[] = [];
        const userReserveDataChunks = _.chunk(
            results,
            reservesAddresses.length * 10
        );
        const allUserReserveObjects: any[] = [];
        for (let j = 0; j < userReserveDataChunks.length; j++) {
            const userReserveDataChunk: any = userReserveDataChunks[j];

            if (userReserveDataChunk.length > 0) {
                let userReservesObjects: any[] = _.map(
                    userReserveDataChunk,
                    (userReserveData, i) => {
                        const userAddress =
                            multicallUserReserveDataParameters[i][1].toString();
                        const reserveAddress =
                            multicallUserReserveDataParameters[i][0].toString();
                        return {
                            tokenAddress: reserveAddress,
                            userAddress: userAddress,
                            currentATokenBalance: userReserveData[0],
                            currentStableDebt: userReserveData[1],
                            currentVariableDebt: userReserveData[2],
                            principalStableDebt: userReserveData[3],
                            scaledVariableDebt: userReserveData[4],
                            stableBorrowRate: userReserveData[5],
                            liquidityRate: userReserveData[6],
                            stableRateLastUpdated:
                                userReserveData[7].toString(),
                            usageAsCollateralEnabled:
                                sqlManager.getBitFromBoolean(
                                    userReserveData[8].toString()
                                ),
                        };
                    }
                );

                allUserReserveObjects.push(...userReservesObjects);

                //update usersReserves that are in memory
                if (!repo.aave[key].hasOwnProperty("usersReserves"))
                    repo.aave[key].usersReserves = {};
                for (let i = 0; i < allUserReserveObjects.length; i++) {
                    const userReservesObject = allUserReserveObjects[i];
                    if (
                        !repo.aave[key].hasOwnProperty(
                            userReservesObject.userAddress
                        )
                    )
                        repo.aave[key].usersReserves[
                            userReservesObject.userAddress
                        ] = [];
                    repo.aave[key].usersReserves[
                        userReservesObject.userAddress
                    ].push(userReservesObject);
                }

                let sqlQuery = `                        
                        MERGE INTO usersReserves AS target
                        USING (VALUES 
                            ${_.map(
                                userReservesObjects,
                                (o) =>
                                    `('${o.userAddress}', '${o.tokenAddress}', '${key}', '${o.currentATokenBalance}', '${o.currentStableDebt}', '${o.currentVariableDebt}', '${o.principalStableDebt}', '${o.scaledVariableDebt}', '${o.stableBorrowRate}', '${o.liquidityRate}', '${o.stableRateLastUpdated}', ${o.usageAsCollateralEnabled}, GETUTCDATE())`
                            ).join(",")}
                        ) AS source (address, tokenAddress, network, currentATokenBalance, currentStableDebt, currentVariableDebt, principalStableDebt, scaledVariableDebt, stableBorrowRate, liquidityRate, stableRateLastUpdated, usageAsCollateralEnabled, modifiedOn)
                        ON (target.address = source.address AND target.tokenAddress = source.tokenAddress AND target.network = source.network)
                        WHEN MATCHED THEN
                        UPDATE SET                        
                            currentATokenBalance = source.currentATokenBalance,
                            currentStableDebt = source.currentStableDebt,
                            currentVariableDebt = source.currentVariableDebt,
                            principalStableDebt = source.principalStableDebt,
                            scaledVariableDebt = source.scaledVariableDebt,
                            stableBorrowRate = source.stableBorrowRate,
                            liquidityRate = source.liquidityRate,
                            stableRateLastUpdated = source.stableRateLastUpdated,
                            usageAsCollateralEnabled = source.usageAsCollateralEnabled,
                            modifiedOn = source.modifiedOn
                            WHEN NOT MATCHED BY TARGET THEN
                        INSERT (address, tokenAddress, network, currentATokenBalance, currentStableDebt, currentVariableDebt, principalStableDebt, scaledVariableDebt, stableBorrowRate, liquidityRate, stableRateLastUpdated, usageAsCollateralEnabled, modifiedOn)
                        VALUES (source.address, source.tokenAddress, source.network, source.currentATokenBalance, source.currentStableDebt, source.currentVariableDebt, source.principalStableDebt, source.scaledVariableDebt, source.stableBorrowRate, source.liquidityRate, source.stableRateLastUpdated, source.usageAsCollateralEnabled, source.modifiedOn);
                            `;

                sqlQueries.push(sqlQuery);
            }
        }

        const allUserReserveObjectsAddresses = _.uniq(
            _.map(allUserReserveObjects, (o) => o.userAddress)
        );
        const liquidatableUserAddressObjects = _.filter(
            userAddressesObjects,
            (o) =>
                o.healthFactor < 1 &&
                _.includes(allUserReserveObjectsAddresses, o.address)
        );
        const liquidatableUserAddressObjectsAddresses = _.map(
            liquidatableUserAddressObjects,
            (o) => o.address
        );
        const liquidatableUserReserves = _.filter(allUserReserveObjects, (o) =>
            liquidatableUserAddressObjectsAddresses.includes(o.userAddress)
        );

        await liquidationManager.checkLiquidateAddressesFromInMemoryObjects(
            aaveNetworkInfo,
            liquidatableUserAddressObjects,
            liquidatableUserReserves
        );

        if (sqlQueries.length > 0) {
            for (const sqlQuery of sqlQueries) {
                await sqlManager.execQuery(sqlQuery);
            }
        } else {
            //we should actually never come here, but just in case
            throw new Error(
                "No user reserves data found for the given addresses"
            );
        }
    }

    //#endregion updateUsersReservesData

    //#region getVar

    getVar(key: string) {
        let val = (this as any)[key];
        if (typeof val == "string") return val;
        else return JSON.stringify(val);
    }

    //#endregion getVar

    //#region setCloseEvent

    setCloseEvent() {
        process.on("SIGINT", async () => {
            console.log("Closing...");
            await sqlManager.closePool();
            process.exit(0);
        });
    }

    //#endregion setCloseEvent

    //#region triggerWebServerAction

    async triggerWebServerAction(type: string, network: string) {
        const liquidationServerEnvironment = await common.getAppSetting(
            "LIQUIDATIONSERVERENVIRONMENT"
        );
        if (this.triggerWebServerActionDevDisabled && !common.isProd) {
            console.log(
                `Skipped triggering web server action ${type} for network ${network}`
            );
            return;
        }
        if (liquidationServerEnvironment == "webServer") {
            await this.refresh(
                {
                    query: {
                        type: type,
                        network: network,
                    },
                },
                {
                    status: (code: number) => {
                        return {
                            send: (message: string) => {
                                console.log(
                                    `Triggered web server action ${type} for network ${network} with response code ${code} and message ${message}`
                                );
                            },
                        };
                    },
                }
            );
        } else {
            await axios.get(
                `${this.webappUrl}/refresh?type=${type}&network=${network}`
            );
        }
    }

    //#endregion triggerWebServerAction

    //#region resetUsersReservesStatus

    /**
     * Resets the status of all users reserves to 1 (updated, still to be loaded in web server)
     * in the database.
     * This is useful to reinitialize the users reserves data in the webServer, so that
     * all users reserves already set to 2 (synced with local model) can be reloaded.
     */
    async resetUsersReservesStatus() {
        if (!repo.aave) throw new Error("Aave object not initialized");
        for (const aaveNetworkInfo of common.getNetworkInfos()) {
            const key = aaveNetworkInfo.network.toString();
            repo.aave[key].usersReserves = {};
            await sqlManager.execQuery(
                `UPDATE addresses SET status = 1 WHERE network = '${key}' AND status > 1`
            );
        }
    }

    //#endregion resetUsersReservesStatus

    //#region refresh

    async refresh(req: any, res: any) {
        const type = req.query.type;
        const network = req.query.network ?? "eth-mainnet";
        if (!type) {
            res.status(400).send("No type provided");
            return;
        }

        await logger.log("refresh: endpoint called for type: " + type);

        switch (type) {
            case "updateGasPrice":
                await this.initializeGasPrice(network);
                break;
            case "updateReserves":
                await this.initializeReserves(network);
                break;
            case "updateReservesPrices":
                await this.initializeReserves(network);
                await this.initializeGasPrice(network);
                //await this.initializeUsersReserves(network); //not needed I think, since only prices have changed here
                await liquidationManager.checkLiquidateAddresses(network);
            case "updateUsersReserves":
                await this.initializeReserves(network);
                await this.initializeGasPrice(network);
                await this.initializeUsersReserves(network);
                await liquidationManager.checkLiquidateAddresses(network);
                break;
            default:
                res.status(400).send("Invalid type provided");
                return;
        }

        res.status(200).send("OK");
    }

    //#endregion refresh

    //#region getUserAccountDataForAddresses

    async getUserAccountDataForAddresses(
        _addresses: string[],
        network: Network
    ) {
        if (!_addresses || _addresses.length == 0) return [];
        const networkInfo = await common.getAaveNetworkInfo(network);

        const userAccountData = await transactionManager.multicall(
            networkInfo.aaveAddresses.pool,
            _addresses,
            Constants.ABIS.POOL_ABI,
            "getUserAccountData",
            network
        );

        //check immediately after retrieving userAccountData if the health factor is less than 1, liquidate concerned addresses
        let userAccountObjects: any[] = [];
        for (let i = 0; i < _addresses.length; i++) {
            const address = _addresses[i];
            const healthFactor = common.getHealthFactorFromUserAccountData(
                userAccountData[i]
            );
            const totalCollateralBase = userAccountData[i][0].toString();
            const totalDebtBase = userAccountData[i][1].toString();
            const currentLiquidationThreshold =
                userAccountData[i][3].toString();
            userAccountObjects.push({
                address: address,
                network: network,
                healthFactor: healthFactor,
                currentLiquidationThreshold: currentLiquidationThreshold,
                totalCollateralBase: totalCollateralBase,
                totalDebtBase: totalDebtBase,
            });
        }

        return userAccountObjects;
    }

    //#endregion getUserAccountDataForAddresses

    //#region updateReservePriceOracleAggregatorAddresses

    async updateReservePriceOracleAggregatorAddresses(aaveNetworkInfo: any) {
        const reservesAddressesQuery = `SELECT address FROM reserves WHERE network = '${aaveNetworkInfo.network.toString()}';`;
        const reservesAddressesResults = await sqlManager.execQuery(
            reservesAddressesQuery
        );
        const reservesAddresses = _.map(
            reservesAddressesResults,
            (o) => o.address
        );
        const priceOracles = await transactionManager.multicall(
            aaveNetworkInfo.aaveAddresses.aaveOracle,
            reservesAddresses,
            Constants.ABIS.AAVE_ORACLE_ABI,
            "getSourceOfAsset",
            aaveNetworkInfo.network
        );

        let aggregators: any[] = [];
        let sqlQuery = "";
        for (let i = 0; i < priceOracles.length; i++) {
            const sourceOfAsset = priceOracles[i][0].toString();

            const contract = common.getContract(
                sourceOfAsset,
                Constants.ABIS.AGGREGATOR_ABI,
                aaveNetworkInfo.network
            );

            let aggregatorAddress: string;
            try {
                aggregatorAddress = await contract.aggregator();
            } catch (error) {
                try {
                    const assetToUsdAggregator =
                        await contract.ASSET_TO_USD_AGGREGATOR();
                    const assetToUsdAggregatorContract = common.getContract(
                        assetToUsdAggregator,
                        Constants.ABIS.AGGREGATOR_ABI,
                        aaveNetworkInfo.network
                    );
                    aggregatorAddress =
                        await assetToUsdAggregatorContract.aggregator();
                } catch (error) {
                    try {
                        const baseToUsdAggregator =
                            await contract.BASE_TO_USD_AGGREGATOR();
                        const baseToUsdAggregatorContract = common.getContract(
                            baseToUsdAggregator,
                            Constants.ABIS.AGGREGATOR_ABI,
                            aaveNetworkInfo.network
                        );
                        aggregatorAddress =
                            await baseToUsdAggregatorContract.aggregator();
                    } catch (error) {
                        aggregatorAddress = "";
                    }
                }
            }

            if (aggregatorAddress) {
                aggregators.push({
                    token: reservesAddresses[i],
                    aggregator: aggregatorAddress.toString(),
                });

                sqlQuery += `WHEN address = '${
                    reservesAddresses[i]
                }' AND network = '${aaveNetworkInfo.network.toString()}' THEN '${aggregatorAddress}'`;
            }
        }

        if (aggregators.length > 0) {
            const query = `UPDATE reserves SET priceOracleAggregatorAddress = CASE ${sqlQuery} ELSE null END;`;
            await sqlManager.execQuery(query);
        }
    }

    //#endregion updateReservePriceOracleAggregatorAddresses

    //#endregion Helper methods

    //#region #Scheduled azure functions

    //
    //
    //
    // space to allow regions to be displayed correctly in VSCode
    //
    //
    //

    //#region updateReservesData

    /**
     * This method should be scheduled to run every day at midnight, since data does should change very often
     * Periodically update the reserves data in the DB
     * @param context the InvocationContext of the function app on azure (for Application Insights)
     */
    async updateReservesData_initialization(
        context: InvocationContext | null = null
    ) {
        logger.initialize("function:updateReservesData", context);
        await this.initializeAlchemy();
    }

    async updateReservesData_loop(
        context: InvocationContext | null,
        network: Network
    ) {
        const key = network.toString();
        const aaveNetworkInfo = common.getAaveNetworkInfo(key);

        const results = await transactionManager.multicall(
            aaveNetworkInfo.aaveAddresses.poolDataProvider,
            null,
            Constants.ABIS.POOL_DATA_PROVIDER_ABI,
            "getAllReservesTokens",
            aaveNetworkInfo.network
        );

        const allReserveTokens: any[] = _.map(results[0][0], (o) => {
            return {
                network: key,
                symbol: o[0].toString(),
                address: o[1].toString(),
            };
        });

        const reserveTokenAddress = await transactionManager.multicall(
            aaveNetworkInfo.aaveAddresses.poolDataProvider,
            _.map(allReserveTokens, (o) => o.address),
            Constants.ABIS.POOL_DATA_PROVIDER_ABI,
            "getReserveTokensAddresses",
            aaveNetworkInfo.network
        );

        //const reserveTokenAddress = results[1][0];
        for (let i = 0; i < reserveTokenAddress.length; i++) {
            allReserveTokens[i].atokenAddress =
                reserveTokenAddress[i][0].toString();
            allReserveTokens[i].stableDebttokenAddress =
                reserveTokenAddress[i][1].toString();
            allReserveTokens[i].variableDebttokenAddress =
                reserveTokenAddress[i][2].toString();
        }

        const allReserveTokensAddresses = _.map(
            allReserveTokens,
            (o) => o.address
        );

        const reservesData = await transactionManager.multicall(
            aaveNetworkInfo.aaveAddresses.poolDataProvider,
            allReserveTokensAddresses,
            Constants.ABIS.POOL_DATA_PROVIDER_ABI,
            "getReserveData",
            aaveNetworkInfo.network
        );

        for (let i = 0; i < reservesData.length; i++) {
            allReserveTokens[i].liquidityIndex = reservesData[i][9].toString();
            allReserveTokens[i].variableBorrowIndex =
                reservesData[i][10].toString();
            allReserveTokens[i].liquidityRate = reservesData[i][5].toString();
            allReserveTokens[i].variableBorrowRate =
                reservesData[i][6].toString();
            allReserveTokens[i].totalStableDebt = reservesData[i][3].toString();
            allReserveTokens[i].lastUpdateTimestamp =
                reservesData[i][11].toString();
            allReserveTokens[i].totalVariableDebt =
                reservesData[i][4].toString();
        }

        const reservesConfigData = await transactionManager.multicall(
            aaveNetworkInfo.aaveAddresses.poolDataProvider,
            allReserveTokensAddresses,
            Constants.ABIS.POOL_DATA_PROVIDER_ABI,
            "getReserveConfigurationData",
            aaveNetworkInfo.network
        );

        //update reserves liquidationProtocolFee
        const liquidationProtocolFees = await transactionManager.multicall(
            aaveNetworkInfo.aaveAddresses.poolDataProvider,
            allReserveTokensAddresses,
            Constants.ABIS.POOL_DATA_PROVIDER_ABI,
            "getLiquidationProtocolFee",
            aaveNetworkInfo.network
        );

        for (let i = 0; i < reservesConfigData.length; i++) {
            allReserveTokens[i].decimals = reservesConfigData[i][0];
            allReserveTokens[i].ltv = reservesConfigData[i][1].toString();
            allReserveTokens[i].reserveLiquidationThreshold =
                reservesConfigData[i][2].toString();
            allReserveTokens[i].reserveLiquidationBonus =
                reservesConfigData[i][3].toString();
            allReserveTokens[i].reserveFactor =
                reservesConfigData[i][4].toString();
            allReserveTokens[i].usageAsCollateralEnabled =
                sqlManager.getBitFromBoolean(reservesConfigData[i][5]);
            allReserveTokens[i].borrowingEnabled = sqlManager.getBitFromBoolean(
                reservesConfigData[i][6]
            );
            allReserveTokens[i].stableBorrowRateEnabled =
                sqlManager.getBitFromBoolean(reservesConfigData[i][7]);
            allReserveTokens[i].isActive = sqlManager.getBitFromBoolean(
                reservesConfigData[i][8]
            );
            allReserveTokens[i].isFrozen = sqlManager.getBitFromBoolean(
                reservesConfigData[i][9]
            );
            allReserveTokens[i].liquidationProtocolFee =
                liquidationProtocolFees[i][0].toString();
        }

        //check if there are reserves in the DB which are not in the reservesList
        //and in case delete them from the DB
        const fetchedReservesAddresses = _.map(
            allReserveTokens,
            (o) => o.address
        );

        //delete reserves and usersReserves data where token address is not in the reserves list
        const sqlQueryDelete = `DELETE FROM usersReserves WHERE tokenAddress NOT IN ('${fetchedReservesAddresses.join(
            "','"
        )}') AND network = '${key}';`;
        await sqlManager.execQuery(sqlQueryDelete);

        const sqlQuery = `DELETE FROM reserves WHERE address NOT IN ('${fetchedReservesAddresses.join(
            "','"
        )}') AND network = '${key}';`;
        await sqlManager.execQuery(sqlQuery);

        //prepare query to update reserves list in DB
        //and update DB
        let reservesSQLList: string[] = _.map(allReserveTokens, (o, index) => {
            return `('${o.address}', '${key}', '${o.symbol}', ${o.decimals}, '${
                o.reserveLiquidationThreshold
            }', '${o.reserveLiquidationBonus}', '${o.reserveFactor}', ${
                o.usageAsCollateralEnabled
            }, ${sqlManager.getBitFromBoolean(
                o.borrowingEnabled
            )}, ${sqlManager.getBitFromBoolean(
                o.stableBorrowRateEnabled
            )}, ${sqlManager.getBitFromBoolean(
                o.isActive
            )}, ${sqlManager.getBitFromBoolean(o.isFrozen)}, '${
                o.liquidationProtocolFee
            }', '${o.liquidityIndex}', '${o.variableBorrowIndex}', '${
                o.liquidityRate
            }', '${o.variableBorrowRate}', '${o.lastUpdateTimestamp}', '${
                o.atokenAddress
            }','${o.variableDebttokenAddress}', '${
                o.stableDebttokenAddress
            }', '${o.totalStableDebt}', '${o.totalVariableDebt}', '${
                o.ltv
            }', ${index}, GETUTCDATE())`;
        });

        if (reservesSQLList.length > 0) {
            const sqlQuery = `
                    MERGE INTO reserves AS target
                    USING (VALUES 
                        ${reservesSQLList.join(",")}
                    ) AS source (address, network, symbol, decimals, reserveLiquidationThreshold, reserveLiquidationBonus, reserveFactor, usageAsCollateralEnabled, borrowingEnabled, stableBorrowRateEnabled, isActive, isFrozen, liquidationProtocolFee, liquidityIndex, variableBorrowIndex, liquidityRate, variableBorrowRate, lastUpdateTimestamp, atokenAddress, variableDebttokenAddress, stableDebttokenAddress, totalStableDebt, totalVariableDebt, ltv, sorting, modifiedOn)
                    ON (target.address = source.address AND target.network = source.network)
                    WHEN MATCHED THEN
                    UPDATE SET                        
                        symbol = source.symbol,
                        decimals = source.decimals,                        
                        reserveLiquidationThreshold = source.reserveLiquidationThreshold,
                        reserveLiquidationBonus = source.reserveLiquidationBonus,
                        reserveFactor = source.reserveFactor,
                        usageAsCollateralEnabled = source.usageAsCollateralEnabled,
                        borrowingEnabled = source.borrowingEnabled,
                        stableBorrowRateEnabled = source.stableBorrowRateEnabled,
                        isActive = source.isActive,
                        isFrozen = source.isFrozen,
                        liquidationProtocolFee = source.liquidationProtocolFee,
                        liquidityIndex = source.liquidityIndex,
                        variableBorrowIndex = source.variableBorrowIndex,
                        liquidityRate = source.liquidityRate,
                        variableBorrowRate = source.variableBorrowRate,                        
                        lastUpdateTimestamp = source.lastUpdateTimestamp,
                        atokenAddress = source.atokenAddress,
                        variableDebttokenAddress = source.variableDebttokenAddress,
                        stableDebttokenAddress = source.stableDebttokenAddress,
                        totalStableDebt = source.totalStableDebt,
                        totalVariableDebt = source.totalVariableDebt,
                        ltv = source.ltv,
                        sorting = source.sorting,
                        modifiedOn = source.modifiedOn
                    WHEN NOT MATCHED BY TARGET THEN
                        INSERT (address, network, symbol, decimals, reserveLiquidationThreshold, reserveLiquidationBonus, reserveFactor, usageAsCollateralEnabled, borrowingEnabled, stableBorrowRateEnabled, isActive, isFrozen, liquidationProtocolFee, liquidityIndex, variableBorrowIndex, liquidityRate, variableBorrowRate, lastUpdateTimestamp, atokenAddress, variableDebttokenAddress, stableDebttokenAddress, totalStableDebt, totalVariableDebt, ltv, sorting, modifiedOn)
                        VALUES (source.address, source.network, source.symbol, source.decimals, source.reserveLiquidationThreshold, source.reserveLiquidationBonus, source.reserveFactor, source.usageAsCollateralEnabled, source.borrowingEnabled, source.stableBorrowRateEnabled, source.isActive, source.isFrozen, source.liquidationProtocolFee, source.liquidityIndex, source.variableBorrowIndex, source.liquidityRate, source.variableBorrowRate, source.lastUpdateTimestamp, source.atokenAddress, source.variableDebttokenAddress, source.stableDebttokenAddress, source.totalStableDebt, source.totalVariableDebt, source.ltv, source.sorting, source.modifiedOn);
                `;

            await sqlManager.execQuery(sqlQuery);

            //update price oracle aggregators for reserves
            await this.updateReservePriceOracleAggregatorAddresses(
                aaveNetworkInfo
            );

            await this.triggerWebServerAction("updateReserves", key);
        }
    }

    //#endregion updateReservesData

    //#region updateUserAccountDataAndUserReserves

    /**
     * This method should be scheduled to run every 2-3 hours
     *
     * Periodically fetches
     * - userAccountData
     * - userConfiguration
     * - userReserves (for each user, for each token)
     * for all addresses in the DB with health factor < 2
     */
    async updateUserAccountDataAndUsersReserves_chunk(
        context: InvocationContext | null,
        network: Network,
        isRecursiveCall: boolean = false
    ) {
        logger.initialize(
            "function:updateUserAccountDataAndUsersReserves",
            context
        );
        await logger.log(
            `Start updateUserAccountDataAndUsersReserves_chunk for network ${network}`
        );

        await this.initializeAlchemy(network);
        await this.initializeReserves(network);
        await this.initializeAddresses(network);

        const chunkSize = Constants.CHUNK_SIZE;
        const key = network.toString();
        const aaveNetworkInfo = await common.getAaveNetworkInfo(network);
        let deleteAddressesQueries: string[] = [];
        const timestampQuery =
            "SELECT * FROM config WHERE [key] = 'lastUpdateUserAccountDataAndUsersReserves'";
        const timestampResult = await sqlManager.execQuery(timestampQuery);
        const timestamp = timestampResult[0].value;

        const dbAddressesArr = await sqlManager.execQuery(
            `SELECT TOP ${chunkSize} * FROM addresses WHERE network = '${key}' AND (STATUS IS NULL OR STATUS < 1) AND addedOn < '${timestamp}'
             ORDER BY addedOn`
        );

        if (dbAddressesArr.length == 0) {
            if (!isRecursiveCall) {
                //if we come here, it means that we have already processed all addresses
                //and we can set the status to null for all addresses
                //and update the lastUpdateUserAccountDataAndUsersReserves timestamp in the config, so that
                //updates can start over again
                const utcNow = moment().utc().format("YYYY-MM-DD HH:mm:ss");
                const query = `
                        UPDATE addresses SET status = NULL WHERE network = '${key}'; 
                        UPDATE config SET [value] = '${utcNow}' WHERE [key] = 'lastUpdateUserAccountDataAndUsersReserves';`;
                await sqlManager.execQuery(query);

                //run the update again, it should start over again
                await this.updateUserAccountDataAndUsersReserves_chunk(
                    context,
                    network,
                    true
                );
            } else {
                await logger.warning(
                    "Recursive call (1) should never fall into here. Addresses: " +
                        dbAddressesArr.length
                );
            }
        } else {
            if (isRecursiveCall) {
                await logger.warning(
                    "Recursive call (2) should never fall into here. Addresses: " +
                        dbAddressesArr.length
                );
            }

            const _addresses = _.map(dbAddressesArr, (a: any) => a.address);

            const results = await this.getUserAccountDataForAddresses(
                _addresses,
                aaveNetworkInfo.network
            );

            const userAccountDataHFGreaterThan2 = _.filter(results, (o) => {
                return o.healthFactor > 2;
            });
            let deleteAddresses = _.map(
                userAccountDataHFGreaterThan2,
                (o) => o.address
            );
            const addressesUserAccountDataHFLowerThan2 = _.filter(
                results,
                (o) => {
                    return o.healthFactor <= 2;
                }
            );

            if (addressesUserAccountDataHFLowerThan2.length > 0) {
                await this.updateUserConfiguration(
                    _.map(
                        addressesUserAccountDataHFLowerThan2,
                        (o) => o.address
                    ),
                    aaveNetworkInfo.network
                );

                for (
                    let i = 0;
                    i < addressesUserAccountDataHFLowerThan2.length;
                    i++
                ) {
                    const userAddress =
                        addressesUserAccountDataHFLowerThan2[i].address;
                    addressesUserAccountDataHFLowerThan2[i].userConfiguration =
                        repo.aave[key].addressesObjects[
                            userAddress
                        ].userConfiguration;
                }

                await this.updateUsersReservesData(
                    addressesUserAccountDataHFLowerThan2,
                    aaveNetworkInfo
                );
            }

            //Save data to the DB:
            //NOTE: it is not necessary to save the totalDebtBase to the DB, since
            //it will be calculated anyway from the usersReserves data.
            //I leave it here anyway for now, since it is not a big deal to save it
            const chunks = _.chunk(results, chunkSize);
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];

                let query =
                    chunk.length > 0
                        ? `
        UPDATE addresses 
        SET 
            modifiedOn = GETUTCDATE(),
            healthFactor = CASE
                {0}
            ELSE healthFactor
            END,                                        
            currentLiquidationThreshold = CASE
                {1}
            ELSE currentLiquidationThreshold
            END,
            totalCollateralBase = CASE
                {2}
            ELSE totalCollateralBase
            END,
            totalDebtBase = CASE
                {3}
            ELSE totalDebtBase
            END
        WHERE address IN ({4}) AND network = '${key}';
    `
                        : "";

                let arr0 = [];
                let arr1 = [];
                let arr2 = [];
                let arr3 = [];
                let arr4 = [];
                for (let i = 0; i < chunk.length; i++) {
                    if (chunk[i].healthFactor < 2) {
                        arr0.push(
                            `WHEN address = '${chunk[i].address}' AND network = '${key}' THEN ${chunk[i].healthFactor}`
                        );
                        arr1.push(
                            `WHEN address = '${chunk[i].address}' AND network = '${key}' THEN '${chunk[i].currentLiquidationThreshold}'`
                        );
                        arr2.push(
                            `WHEN address = '${chunk[i].address}' AND network = '${key}' THEN '${chunk[i].totalCollateralBase}'`
                        );
                        arr3.push(
                            `WHEN address = '${chunk[i].address}' AND network = '${key}' THEN '${chunk[i].totalDebtBase}'`
                        );
                        arr4.push(`'${chunk[i].address}'`);
                    } else {
                        deleteAddresses.push(chunk[i].address);
                    }
                }

                query = query.replace("{0}", arr0.join(" "));
                query = query.replace("{1}", arr1.join(" "));
                query = query.replace("{2}", arr2.join(" "));
                query = query.replace("{3}", arr3.join(" "));
                query = query.replace("{4}", arr4.join(","));

                if (query) await sqlManager.execQuery(query);
            }

            //delete addresses from the DB where health factor is > 2
            deleteAddresses = _.uniq(deleteAddresses);
            if (deleteAddresses.length > 0) {
                const chunks = _.chunk(deleteAddresses, chunkSize);
                for (let i = 0; i < chunks.length; i++) {
                    const sqlQuery = `
            DELETE FROM addresses WHERE address IN ('${chunks[i].join(
                "','"
            )}') AND network = '${key}';
            DELETE FROM usersReserves WHERE address IN ('${chunks[i].join(
                "','"
            )}') AND network = '${key}';
            `;
                    deleteAddressesQueries.push(sqlQuery);
                }
            }

            for (const deleteAddressesQuery of deleteAddressesQueries) {
                await sqlManager.execQuery(deleteAddressesQuery);
            }

            const addressesPresent = _.without(_addresses, ...deleteAddresses);
            if (addressesPresent.length > 0) {
                const query1 = `UPDATE addresses SET status = 1 WHERE address IN ('${addressesPresent.join(
                    "','"
                )}') AND network = '${key}';`;
                await sqlManager.execQuery(query1);
            }
        }
        await this.triggerWebServerAction("updateUsersReserves", key);

        await logger.log("updateUserAccountDataAndUsersReserves_chunk: End");
    }

    //#endregion updateUserAccountDataAndUserReserves

    //#region updateGasPrice

    async updateGasPrice(context: InvocationContext | null = null) {
        logger.initialize("function:updateGasPrice", context);
        await this.initializeAlchemy();
        for (const aaveNetworkInfo of common.getNetworkInfos()) {
            await this.triggerWebServerAction(
                "updateGasPrice",
                aaveNetworkInfo.network
            );
        }
        await logger.log("updateGasPrice: End");
    }

    //#endregion updateCloseFactor

    //#region updateReservesPrices

    /**
     *  Gets the newest assets prices for the given network or all networks and updates the prices in the DB if the prices have changed
     *  beyond a certain treshold (currently set at 0.0005 ETH), then it
     *  calculates the health factor for the addresses that have the reserves whose prices have changed, either as collateral or as debt
     *  and liquidates them if their health factor is below 1. The method is defined as a function and called periodically on azure
     *
     * //TODO connect to smart contract for liquidation process
     *
     * @param network
     * @param context the InvocationContext of the function app on azure (for Application Insights logging)
     */
    async updateReservesPrices(
        context: InvocationContext | null = null,
        network: Network | null = null //if network is not defined, loop through all networks
    ) {
        logger.initialize("function:updateReservesPrices", context);
        await logger.log("updateReservesPrices: Start");

        await this.initializeAlchemy(network);
        await this.initializeReserves(network);

        for (const aaveNetworkInfo of common.getNetworkInfos()) {
            if (network && network != aaveNetworkInfo.network) continue;
            const key = aaveNetworkInfo.network.toString();

            //get last saved reserves prices from the DB
            let dbAssetsPrices = common.getJsonObjectFromKeyValuesArray(
                _.values(aaveNetworkInfo.reserves),
                "address",
                "price"
            );

            //get current reserves prices from the network
            const aaveOracleContract = common.getContract(
                aaveNetworkInfo.aaveAddresses.aaveOracle,
                Constants.ABIS.AAVE_ORACLE_ABI,
                aaveNetworkInfo.network
            );
            const reservesAddresses = Object.keys(aaveNetworkInfo.reserves);
            const currentAssetsPrices =
                await aaveOracleContract.getAssetsPrices(reservesAddresses);

            let newReservesPrices: any = {};
            for (let i = 0; i < reservesAddresses.length; i++) {
                const reserveAddress = reservesAddresses[i];
                const price = currentAssetsPrices[i];
                newReservesPrices[reserveAddress] = price;
            }

            let reservesDbUpdate: any[] = [];
            for (const reserveAddress of reservesAddresses) {
                const oldPrice = dbAssetsPrices[reserveAddress];
                const newPrice =
                    new Big(newReservesPrices[reserveAddress]).toNumber() / 1e8;
                if (!oldPrice) {
                    //mark current reserve to be updated in the DB since no previous price is defined
                    reservesDbUpdate.push({
                        address: reserveAddress,
                        price: newPrice,
                    });
                    continue;
                }
                const normalizedChange = newPrice - oldPrice;

                //if the normalized change is greater than the given treshold (for now 0.5 USD), we should perform the check
                if (Math.abs(normalizedChange) > 0.5) {
                    //mark current reserve to be updated in the DB since the change exceeds the treshold
                    reservesDbUpdate.push({
                        address: reserveAddress,
                        price: newPrice,
                    });
                }
            }

            if (reservesDbUpdate.length > 0) {
                let reservesSQLList: string[] = _.map(reservesDbUpdate, (o) => {
                    return `('${o.address}', '${key}', ${o.price}, GETUTCDATE())`;
                });

                if (reservesSQLList.length > 0) {
                    const sqlQuery = `
                    MERGE INTO reserves AS target
                    USING (VALUES 
                        ${reservesSQLList.join(",")}
                    ) AS source (address, network, price, priceModifiedOn)
                    ON (target.address = source.address AND target.network = source.network)
                    WHEN MATCHED THEN
                    UPDATE SET                    
                        priceModifiedOn = source.priceModifiedOn,    
                        price = source.price;                        
                        `;

                    await sqlManager.execQuery(sqlQuery);

                    await this.triggerWebServerAction(
                        "updateReservesPrices",
                        key
                    );
                } else {
                    //we should actually never come here, but just in case
                    throw new Error(
                        "reservesSQLList is empty despite reservesDbUpdate being not empty"
                    );
                }
            }
        }

        await logger.log("updateReservesPrices: End");
    }

    //#endregion updateReservesPrices

    //#region deleteOldTablesEntries

    /**
     * deletes old entries from the logs table older than 2 days
     * so that the table does not grow indefinitely
     *
     * @param context the InvocationContext of the function app (for Application Insights logging)
     */
    async deleteOldTablesEntries(context: InvocationContext | null = null) {
        logger.initialize("function:deleteOldTablesEntries", context);
        const query = `
            DELETE FROM dbo.logs WHERE timestamp < DATEADD(DAY, -2, GETUTCDATE());            
        `;
        await sqlManager.execQuery(query);
    }

    //#endregion Function: deleteOldTablesEntries

    //#endregion Scheduled azure functions

    //#region #Testing

    async doTest() {
        await this.updateUserAccountDataAndUsersReserves_chunk(
            null,
            Network.ARB_MAINNET
        );
        /*
        const result = await transactionManager.sendSingleTransaction(
            aaveNetworkInfo,
            "store",
            6
        );
        console.log(result);
        */
    }

    //#endregion Testing methods
}

export default Engine.getInstance();
