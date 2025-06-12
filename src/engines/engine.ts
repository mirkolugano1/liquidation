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
import redisManager from "../managers/redisManager";
import { sql } from "@azure/functions/types/app";
import { query } from "mssql";
import { red } from "bn.js";

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
            const initAddresses = await redisManager.getList(
                `addresses:${key}:*`
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
                const queryAddresses: any = await redisManager.call(
                    "FT.SEARCH",
                    "idx:addresses",
                    `@status:[1 1] @network:{${key}}`,
                    "LIMIT",
                    "0",
                    `${Constants.CHUNK_SIZE}`
                );
                const addressList = _.map(
                    queryAddresses,
                    (o) => o.address
                ).join("|");

                hasAddressesToBeLoaded = queryAddresses.length > 0;
                if (hasAddressesToBeLoaded) {
                    const dbUsersReserves: any = await redisManager.call(
                        "FT.SEARCH",
                        "idx:usersReserves",
                        `@network:{${key}} @address:{${addressList}}`,
                        "LIMIT",
                        "0",
                        "9999999"
                    );
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

                //set status to 2 for all addresses that have been loaded
                _.each(queryAddresses, (o) => {
                    o.status = 2;
                });
                await redisManager.setArrayProperties(queryAddresses, "status");
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

            const dbReserves: any = await redisManager.getList(
                `reserves:${key}:*`,
                "sorting"
            );

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

        const addressList = addresses.join("|");
        const addressesToUpdate: any = await redisManager.call(
            "FT.SEARCH",
            "idx:addresses",
            `@network:{${aaveNetworkInfo.network.toString()}} @status:[1 1] @address:{${addressList}}`,
            "LIMIT",
            "0",
            "1000000"
        );

        for (let i = 0; i < userConfigurations.length; i++) {
            const userConfiguration = new Big(userConfigurations[i])
                .toNumber()
                .toString(2);
            addressesToUpdate[i].userConfiguration = userConfiguration;
        }

        await redisManager.setArrayProperties(
            addressesToUpdate,
            "userConfiguration"
        );
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

        let userReservesObjects: any[] = [];
        if (results.length > 0) {
            userReservesObjects = _.map(results, (userReserveData, i) => {
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
                    stableRateLastUpdated: userReserveData[7].toString(),
                    usageAsCollateralEnabled: sqlManager.getBitFromBoolean(
                        userReserveData[8].toString()
                    ),
                };
            });

            const redisUserReservesKeys = _.map(
                userReservesObjects,
                (o: any) =>
                    `usersReserves:${key}:${o.userAddress}:${o.tokenAddress}`
            );
            await redisManager.set(redisUserReservesKeys, userReservesObjects);
        }

        const allUserReserveObjectsAddresses = _.uniq(
            _.map(userReservesObjects, (o) => o.userAddress)
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
        const liquidatableUserReserves = _.filter(userReservesObjects, (o) =>
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
        const reservesAddressesResults: any = redisManager.getList(
            `reserves:${aaveNetworkInfo.network.toString()}:*`,
            "sorting"
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

            if (
                aggregatorAddress &&
                aggregatorAddress.toString() !=
                    reservesAddressesResults[i].priceOracleAggregatorAddress
            ) {
                reservesAddressesResults[i].priceOracleAggregatorAddress =
                    aggregatorAddress;
                aggregators.push(reservesAddressesResults[i]);
            }
        }

        if (aggregators.length > 0) {
            const keys = _.map(
                aggregators,
                (o) =>
                    `reserves:${aaveNetworkInfo.network.toString()}:${
                        o.address
                    }`
            );
            await redisManager.set(keys, aggregators);
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

        if (allReserveTokens.length > 0) {
            const reservesKeys = _.map(
                allReserveTokens,
                (o) => `reserves:${o.network}:${o.address}`
            );
            await redisManager.set(reservesKeys, allReserveTokens);

            //update price oracle aggregators for reserves
            await this.updateReservePriceOracleAggregatorAddresses(
                aaveNetworkInfo
            );
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
        const timestamp = await redisManager.getValue(
            "config:lastUpdateUserAccountDataAndUsersReserves"
        );

        const dbAddressesArr = await redisManager.call(
            "FT.SEARCH",
            "idx:addresses",
            `@network:{${key}} (@status:{} | @status:{0}) @addedOn:{-inf (${timestamp}}`,
            "SORTBY",
            "addedOn",
            "ASC",
            "LIMIT",
            "0",
            chunkSize.toString()
        );

        if (dbAddressesArr.length == 0) {
            if (!isRecursiveCall) {
                //if we come here, it means that we have already processed all addresses
                //and we can set the status to null for all addresses
                //and update the lastUpdateUserAccountDataAndUsersReserves timestamp in the config, so that
                //updates can start over again
                const utcNow = moment().utc().format("YYYY-MM-DD HH:mm:ss");
                await redisManager.set(
                    "config:lastUpdateUserAccountDataAndUsersReserves",
                    utcNow
                );

                const allAddresses = await redisManager.getList(
                    `addresses:${key}:*`
                );
                _.each(allAddresses, (address) => (address.status = null));
                await redisManager.setArrayProperties(allAddresses, "status");

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
                    addressesUserAccountDataHFLowerThan2[i].status = 1;
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
            const keys = _.map(
                addressesUserAccountDataHFLowerThan2,
                (o) => `addresses:${key}:${o.address}`
            );
            redisManager.set(keys, addressesUserAccountDataHFLowerThan2);

            //delete addresses from the DB where health factor is > 2
            const userAccountDataHFGreaterThan2AddressesString = _.map(
                userAccountDataHFGreaterThan2,
                (o) => o.address
            ).join("|");
            await redisManager.deleteByQuery(
                "addresses",
                `@network:{${key}} @address:{${userAccountDataHFGreaterThan2AddressesString}}`
            );
            await redisManager.deleteByQuery(
                "usersReserves",
                `@network:{${key}} @address:{${userAccountDataHFGreaterThan2AddressesString}}`
            );
        }

        await logger.log("updateUserAccountDataAndUsersReserves_chunk: End");
    }

    //#endregion updateUserAccountDataAndUserReserves

    //#region updateGasPrice

    async updateGasPrice(context: InvocationContext | null = null) {
        logger.initialize("function:updateGasPrice", context);
        await this.initializeAlchemy();
        for (const aaveNetworkInfo of common.getNetworkInfos()) {
            this.initializeGasPrice(aaveNetworkInfo.network);
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
                const priceUpdateReserves: any = await redisManager.call(
                    "FT.SEARCH",
                    "idx:reserves",
                    `@network:{${key}} @address:{${_.map(
                        reservesDbUpdate,
                        (o) => o.address
                    ).join("|")}}`
                );
                _.each(priceUpdateReserves, (o) => {
                    o.priceModifiedOn = moment
                        .utc()
                        .format("YYYY-MM-DD HH:mm:ss");
                });

                await redisManager.setArrayProperties(priceUpdateReserves, [
                    "price",
                    "priceModifiedOn",
                ]);
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

    async migrateDataToRedis() {
        //migrate data from SQL to Redis
        console.log("migrating data from SQL to Redis...");
        await redisManager.deleteAllData();

        let result = await sqlManager.execQuery("Select * from config");
        let keys = _.map(result, (o) => `config:${o.key}`);
        await redisManager.set(keys, result);

        result = await sqlManager.execQuery("Select * from addresses");
        keys = _.map(result, (o) => `addresses:${o.network}:${o.address}`);
        await redisManager.set(keys, result);

        result = await sqlManager.execQuery("Select * from reserves");
        keys = _.map(result, (o) => `reserves:${o.network}:${o.address}`);
        await redisManager.set(keys, result);

        console.log("successfully set data in redis");
    }

    async createRedisIndexes() {
        //create indexes in Redis
        console.log("creating indexes in Redis...");
        redisManager.deleteAllIndexes();

        await redisManager.call(
            "FT.CREATE",
            "idx:usersReserves",
            "ON",
            "JSON",
            "PREFIX",
            "1",
            "usersReserves:",
            "SCHEMA",
            "$.network",
            "AS",
            "network",
            "TAG",
            "$.address",
            "AS",
            "address",
            "TAG",
            "$.tokenAddress",
            "AS",
            "tokenAddress",
            "TAG",
            "$.currentATokenBalance",
            "AS",
            "currentATokenBalance",
            "NUMERIC",
            "$.currentStableDebt",
            "AS",
            "currentStableDebt",
            "NUMERIC",
            "$.currentVariableDebt",
            "AS",
            "currentVariableDebt",
            "NUMERIC",
            "$.principalStableDebt",
            "AS",
            "principalStableDebt",
            "NUMERIC",
            "$.scaledVariableDebt",
            "AS",
            "scaledVariableDebt",
            "NUMERIC",
            "$.stableBorrowRate",
            "AS",
            "stableBorrowRate",
            "NUMERIC",
            "$.liquidityRate",
            "AS",
            "liquidityRate",
            "NUMERIC",
            "$.stableRateLastUpdated",
            "AS",
            "stableRateLastUpdated",
            "NUMERIC",
            "$.usageAsCollateralEnabled",
            "AS",
            "usageAsCollateralEnabled",
            "TAG",
            "$.modifiedOn",
            "AS",
            "modifiedOn",
            "TAG"
        );

        await redisManager.call(
            "FT.CREATE",
            "idx:reserves",
            "ON",
            "JSON",
            "PREFIX",
            "1",
            "reserves:",
            "SCHEMA",
            "$.network",
            "AS",
            "network",
            "TAG",
            "$.address",
            "AS",
            "address",
            "TAG",
            "$.symbol",
            "AS",
            "symbol",
            "TAG",
            "$.decimals",
            "AS",
            "decimals",
            "NUMERIC",
            "$.reserveLiquidationThreshold",
            "AS",
            "reserveLiquidationThreshold",
            "NUMERIC",
            "$.reserveLiquidationBonus",
            "AS",
            "reserveLiquidationBonus",
            "NUMERIC",
            "$.reserveFactor",
            "AS",
            "reserveFactor",
            "NUMERIC",
            "$.usageAsCollateralEnabled",
            "AS",
            "usageAsCollateralEnabled",
            "TAG",
            "$.borrowingEnabled",
            "AS",
            "borrowingEnabled",
            "TAG",
            "$.stableBorrowRateEnabled",
            "AS",
            "stableBorrowRateEnabled",
            "TAG",
            "$.isActive",
            "AS",
            "isActive",
            "TAG",
            "$.isFrozen",
            "AS",
            "isFrozen",
            "TAG",
            "$.liquidityIndex",
            "AS",
            "liquidityIndex",
            "NUMERIC",
            "$.variableBorrowIndex",
            "AS",
            "variableBorrowIndex",
            "NUMERIC",
            "$.liquidityRate",
            "AS",
            "liquidityRate",
            "NUMERIC",
            "$.variableBorrowRate",
            "AS",
            "variableBorrowRate",
            "NUMERIC",
            "$.lastUpdateTimestamp",
            "AS",
            "lastUpdateTimestamp",
            "NUMERIC",
            "$.aTokenAddress",
            "AS",
            "aTokenAddress",
            "TAG",
            "$.totalStableDebt",
            "AS",
            "totalStableDebt",
            "TAG",
            "$.totalVariableDebt",
            "AS",
            "totalVariableDebt",
            "TAG",
            "$.ltv",
            "AS",
            "ltv",
            "NUMERIC",
            "$.price",
            "AS",
            "price",
            "NUMERIC",
            "$.variableDebtTokenAddress",
            "AS",
            "variableDebtTokenAddress",
            "TAG",
            "$.stableDebtTokenAddress",
            "AS",
            "stableDebtTokenAddress",
            "TAG",
            "$.sorting",
            "AS",
            "sorting",
            "NUMERIC",
            "$.modifiedOn",
            "AS",
            "modifiedOn",
            "TAG",
            "$.priceModifiedOn",
            "AS",
            "priceModifiedOn",
            "TAG",
            "$.liquidationProtocolFee",
            "AS",
            "liquidationProtocolFee",
            "NUMERIC",
            "$.priceOracleAggregatorAddress",
            "AS",
            "priceOracleAggregatorAddress",
            "TAG"
        );

        await redisManager.call(
            "FT.CREATE",
            "idx:addresses",
            "ON",
            "JSON",
            "PREFIX",
            "1",
            "addresses:",
            "SCHEMA",
            "$.network",
            "AS",
            "network",
            "TAG",
            "$.address",
            "AS",
            "address",
            "TAG",
            "$.healthFactor",
            "AS",
            "healthFactor",
            "NUMERIC",
            "$.totalDebtBase",
            "AS",
            "totalDebtBase",
            "NUMERIC",
            "$.totalCollateralBase",
            "AS",
            "totalCollateralBase",
            "NUMERIC",
            "$.currentLiquidationThreshold",
            "AS",
            "currentLiquidationThreshold",
            "NUMERIC",
            "$.addedOn",
            "AS",
            "addedOn",
            "TAG",
            "$.modifiedOn",
            "AS",
            "modifiedOn",
            "TAG",
            "$.userConfiguration",
            "AS",
            "userConfiguration",
            "TAG",
            "$.status",
            "AS",
            "status",
            "NUMERIC"
        );

        console.log("successfully created indexes in redis");
    }

    async doTest() {
        //await this.migrateDataToRedis();
        //await this.createRedisIndexes();
        const retrievedObjects = await redisManager.getList("addresses:*");
        console.log(retrievedObjects.length); // Should print: [{ key: "value", number: 42 }, { key: "value2", number: 43 }]
        //return;

        /*
        await this.updateUserAccountDataAndUsersReserves_chunk(
            null,
            Network.ARB_MAINNET
        );
        
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
