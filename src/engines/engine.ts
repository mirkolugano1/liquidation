//#region #Imports

import common from "../shared/common";
import _ from "lodash";
import encryption from "../managers/encryptionManager";
import sqlManager from "../managers/sqlManager";
import { ethers } from "ethers";
import Big from "big.js";
import logger from "../shared/logger";
import { InvocationContext } from "@azure/functions";
import { LoggingFramework, LogType } from "../shared/enums";
import Constants from "../shared/constants";
import { Alchemy, Network } from "alchemy-sdk";
import emailManager from "../managers/emailManager";
import axios from "axios";
import { r } from "tar";
import repo from "../shared/repo";
import liquidationManager from "../managers/liquidationManager";
import multicallManager from "../managers/multicallManager";

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

        if (repo.updateUsersReservesOnStart) {
            await this.initializeReserves();
            await this.initializeUsersReserves();
            await this.initializeGasPrice();
        }

        repo.isWebServerInitialized = true;
    }

    //#endregion initializeWebServer

    //#region initializeAddresses

    async initializeAddresses() {
        const initAddresses = await sqlManager.execQuery(
            "SELECT * FROM addresses"
        );
        for (const address of initAddresses) {
            if (!repo.aave[address.network].hasOwnProperty("addresses"))
                repo.aave[address.network].addresses = [];
            repo.aave[address.network].addresses.push(address.address);

            if (!repo.aave[address.network].hasOwnProperty("addressesObjects"))
                repo.aave[address.network].addressesObjects = {};
            repo.aave[address.network].addressesObjects[address.address] =
                address;
        }
    }

    //#endregion initializeAddresses

    //#region initializeUsersReserves

    async initializeUsersReserves(network: Network | null = null) {
        if (!repo.aave) throw new Error("Aave object not initialized");
        const _key = network?.toString() ?? null;
        let query = `SELECT * FROM usersReserves`;
        if (_key) query += ` WHERE network = '${_key}'`;
        const dbUsersReserves = await sqlManager.execQuery(query);
        if (!dbUsersReserves || dbUsersReserves.length == 0) {
            await logger.log(
                "No reserves found in DB. Please run the updateReservesData function first.",
                "functionAppExecution"
            );
            return;
        }

        let usersReserves: any = {};
        for (const aaveNetworkInfo of Constants.AAVE_NETWORKS_INFOS) {
            const key = aaveNetworkInfo.network.toString();
            if (_key && key != _key) continue;

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
            for (let i = 0; i < repo.aave[key].addresses.length; i++) {
                const address = repo.aave[key].addresses[i];
                if (!repo.aave[key].usersReserves[address]) continue;
                const userReserves = repo.aave[key].usersReserves[address];
                const externalCollateral = userReserves.reduce(
                    (total: any, userReserve: any) => {
                        return total + userReserve.currentATokenBalance;
                    },
                    0
                );

                repo.aave[key].addressesObjects[address].externalCollateral =
                    externalCollateral;
            }
        }
    }

    //#endregion initializeUsersReserves

    //#region initializeReserves

    async initializeReserves(network: Network | null = null) {
        if (!repo.aave) throw new Error("Aave object not initialized");
        const _key = network?.toString() ?? null;
        let query = `SELECT * FROM reserves ORDER BY sorting`;
        if (_key) query += ` WHERE network = '${_key}'`;
        const dbReserves = await sqlManager.execQuery(query);
        if (!dbReserves || dbReserves.length == 0) {
            await logger.log(
                "No reserves found in DB. Please run the updateReservesData function first.",
                "functionAppExecution"
            );
            return;
        }

        let reserves: any = {};
        for (const aaveNetworkInfo of Constants.AAVE_NETWORKS_INFOS) {
            const key = aaveNetworkInfo.network.toString();
            if (_key && key != _key) continue;

            const networkReserves = _.filter(dbReserves, { network: key });
            for (let networkReserve of networkReserves) {
                reserves[networkReserve.address] = networkReserve;
            }
            repo.aave[key].reserves = reserves;
        }
    }

    //#endregion initializeReserves

    //#region initializeGasPrice

    async initializeGasPrice(network: Network | null = null) {
        if (!repo.aave) throw new Error("Aave object not initialized");
        for (const aaveNetworkInfo of Constants.AAVE_NETWORKS_INFOS) {
            if (network && network != aaveNetworkInfo.network) continue;
            const gasPrice = await aaveNetworkInfo.alchemy.core.getGasPrice();
            repo.aave[aaveNetworkInfo.network].gasPrice = gasPrice;
        }
    }

    //#endregion initializeGasPrice

    //#region initializeAlchemy

    async initializeAlchemy() {
        if (repo.aave) return;
        repo.aave = {};

        this.webappUrl = await common.getAppSetting("WEBAPPURL");

        const alchemyKey = await encryption.getAndDecryptSecretFromKeyVault(
            "ALCHEMYKEYENCRYPTED"
        );

        if (!alchemyKey) {
            await logger.log(
                "No Alchemy key found. Please set the ALCHEMYKEYENCRYPTED environment variable.",
                "functionAppExecution"
            );
            return;
        }

        for (const aaveNetworkInfo of Constants.AAVE_NETWORKS_INFOS) {
            const key = aaveNetworkInfo.network.toString();

            const config = {
                apiKey: alchemyKey, // Replace with your API key
                network: aaveNetworkInfo.network,
            };
            const alchemy = new Alchemy(config);
            const alchemyProvider = await alchemy.config.getProvider();

            let networkInfo: any = _.assign(aaveNetworkInfo, {
                alchemy: alchemy,
                alchemyProvider: alchemyProvider,
            });

            repo.aave[key] = networkInfo;

            const addresses = await multicallManager.multicall(
                aaveNetworkInfo.aaveAddresses.poolAddressesProvider,
                null,
                "ADDRESSES_PROVIDER_ABI",
                ["getPoolDataProvider", "getPriceOracle", "getPool"],
                aaveNetworkInfo.network
            );

            if (!addresses) {
                await logger.log(
                    `No addresses found for network ${aaveNetworkInfo.network.toString()}. Please run the updateReservesData function first.`,
                    "functionAppExecution"
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

    triggerWebServerActionDevDisabled: boolean = false;
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
        const userConfigurations = await multicallManager.multicall(
            aaveNetworkInfo.aaveAddresses.pool,
            addresses,
            "POOL_ABI",
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
        repo.isUsersReservesSyncInProgress = true;
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

        const results = await multicallManager.multicall(
            aaveNetworkInfo.aaveAddresses.poolDataProvider,
            multicallUserReserveDataParameters,
            "POOL_DATA_PROVIDER_ABI",
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

                //update usersReserves in memory
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

    //#region refresh

    async refresh(req: any, res: any) {
        const type = req.query.type;
        const network = req.query.network ?? "eth-mainnet";
        if (!type) {
            res.status(400).send("No type provided");
            return;
        }

        switch (type) {
            case "updateGasPrice":
                await this.initializeGasPrice(network);
                break;
            case "updateReserves":
                await this.initializeReserves(network);
                break;
            case "updateReservesPrices":
                await this.initializeReserves();
                if (!repo.isUsersReservesSynced) {
                    await this.initializeGasPrice();
                    await this.initializeUsersReserves();
                } else
                    await liquidationManager.checkLiquidateAddresses(network);
                break;
            case "updateUsersReserves":
                if (!repo.isUsersReservesSynced) {
                    await this.initializeReserves();
                    await this.initializeGasPrice();
                }
                await this.initializeUsersReserves();
                if (repo.temporaryBlocks.length > 0) {
                    for (let i = 0; i < repo.temporaryBlocks.length; i++) {
                        const block = repo.temporaryBlocks[i];
                        const shouldCheckLiquidationOpportunities =
                            i == repo.temporaryBlocks.length - 1;
                        await this.syncInMemoryData(
                            block,
                            shouldCheckLiquidationOpportunities,
                            network
                        );
                    }
                    repo.temporaryBlocks = [];
                }
                repo.isUsersReservesSynced = true;
                repo.isUsersReservesSyncInProgress = false;
                break;
            default:
                res.status(400).send("Invalid type provided");
                return;
        }

        res.status(200).send("OK");
    }

    //#endregion refresh

    //#region syncInMemoryData

    async syncInMemoryData(
        block: any,
        shouldCheckLiquidationOpportunities: boolean,
        network: string
    ) {
        const key = network;
        for (let log of block.logs) {
            let topics = log.topics;
            let eventHash = topics[0];
            const addressesObjectsAddresses = _.map(
                repo.aave[key].addressesObjects,
                (o) => o.address
            );

            switch (eventHash) {
                case "0x9a2f48d3aa6146e0a0f4e8622b5ff4b9d90a3c4f5e9a3b69c8523e213f775bfe": //LiquidationCall
                    const decodedLogLiquidationCall =
                        repo.ifaceLiquidationCall.parseLog(log);
                    const userLiquidator =
                        decodedLogLiquidationCall.args.liquidator;
                    const userLiquidated = log.topics[3];
                    const liquidationCollateralAsset = log.topics[1];
                    const liquidationDebtAsset = log.topics[2];
                    const liquidatedCollateralAmount =
                        decodedLogLiquidationCall.args
                            .liquidatedCollateralAmount;
                    const debtToCover =
                        decodedLogLiquidationCall.args.debtToCover;
                    const receiveAToken =
                        decodedLogLiquidationCall.args.receiveAToken;

                    if (addressesObjectsAddresses.includes(userLiquidated)) {
                        //detract the liquidated collateral amount from the user's collateral
                        repo.aave[key].usersReserves[userLiquidated][
                            liquidationCollateralAsset
                        ].currentATokenBalance -= liquidatedCollateralAmount;

                        //detract the debt to cover from the user's debt
                        if (
                            repo.aave[key].usersReserves[userLiquidated][
                                liquidationDebtAsset
                            ].currentStableDebt >= debtToCover
                        ) {
                            repo.aave[key].usersReserves[userLiquidated][
                                liquidationDebtAsset
                            ].currentStableDebt -= debtToCover;
                        } else {
                            repo.aave[key].usersReserves[userLiquidated][
                                liquidationDebtAsset
                            ].currentVariableDebt -= debtToCover;
                        }

                        await this.updateUserConfiguration(userLiquidated, key);
                    }

                    if (addressesObjectsAddresses.includes(userLiquidator)) {
                        if (receiveAToken) {
                            //add the liquidated collateral amount to the liquidator's collateral
                            repo.aave[key].usersReserves[userLiquidator][
                                liquidationCollateralAsset
                            ].currentATokenBalance +=
                                liquidatedCollateralAmount;
                        }

                        //not necessary to check for liquidation, since collateral has increased
                        //not necessary to update userConfiguration. If reserve was already set as collateral,
                        //this does not change anyway.
                    }
                    break;

                //Deposit
                case "0xde6857219544bb5b7746f48ed30be6386fefc61b2f864cacf559893bf50fd951":
                    const decodedLogDeposit = repo.ifaceDeposit.parseLog(log);
                    const depositReserve = log.topics[1];
                    const depositAmount = decodedLogDeposit.args.amount;
                    const depositOnBehalfOf = log.topics[3];
                    if (
                        addressesObjectsAddresses.includes(depositOnBehalfOf) &&
                        liquidationManager.isReserveUsedAsCollateral(
                            repo.aave[key].addressesObjects[depositOnBehalfOf]
                                .userConfiguration,
                            depositReserve,
                            key
                        )
                    ) {
                        repo.aave[key].usersReserves[depositOnBehalfOf][
                            depositReserve
                        ].currentATokenBalance += depositAmount;
                    }
                    break;

                //Borrow
                case "0xc6a898309e823ee50bac64e45ca8adba6690e99e7841c45d754e2a38e9019d9b":
                    const decodedLogBorrow = repo.ifaceBorrow.parseLog(log);
                    const borrowOnBehalfOf = log.topics[3];
                    const borrowReserve = log.topics[1];
                    const borrowedAmount = decodedLogBorrow.args.amount;
                    const borrowRateMode = decodedLogBorrow.args.borrowRateMode;
                    if (addressesObjectsAddresses.includes(borrowOnBehalfOf)) {
                        if (borrowRateMode == 1) {
                            repo.aave[key].usersReserves[borrowOnBehalfOf][
                                borrowReserve
                            ].currentStableDebt += borrowedAmount;
                        } else {
                            repo.aave[key].usersReserves[borrowOnBehalfOf][
                                borrowReserve
                            ].currentVariableDebt += borrowedAmount;
                        }

                        if (shouldCheckLiquidationOpportunities) {
                            await liquidationManager.checkLiquidateAddresses(
                                borrowOnBehalfOf,
                                key
                            );
                        }
                    }

                    break;

                case "0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051": //Repay
                    const repayReserve = log.topics[1];
                    const decodedLogRepay = repo.ifaceRepay.parseLog(log);
                    const amountRepayed = decodedLogRepay.args.amount;
                    const useATokens = decodedLogRepay.args.useATokens;

                    //detract the amount repaid from the repayer's collateral
                    if (
                        addressesObjectsAddresses.includes(log.topics[3]) &&
                        useATokens
                    ) {
                        repo.aave[key].usersReserves[log.topics[3]][
                            repayReserve
                        ].currentATokenBalance -= amountRepayed;
                    }

                    //detract the repaid amount from the beneficiary's debt
                    if (addressesObjectsAddresses.includes(log.topics[2])) {
                        const address = log.topics[2];
                        const repayUserReserve =
                            repo.aave[key].usersReserves[address][repayReserve];

                        //I cannot know if the debt being repaid is stable or variable, since this info
                        //is not present in the Repay event. So I check the amount of the variable debt and
                        //evtl then even the stable debt, since in the end I am interested in the total debt
                        if (
                            repayUserReserve.currentStableDebt == 0 ||
                            repayUserReserve.currentVariableDebt >=
                                amountRepayed
                        ) {
                            repo.aave[key].usersReserves[address][
                                repayReserve
                            ].currentVariableDebt -= amountRepayed;
                        } else {
                            repo.aave[key].usersReserves[address][
                                repayReserve
                            ].currentStableDebt -= amountRepayed;
                        }

                        if (shouldCheckLiquidationOpportunities) {
                            await liquidationManager.checkLiquidateAddresses(
                                address,
                                key
                            );
                        }
                        await this.updateUserConfiguration(address, key);
                    }
                    break;

                case "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61": //Supply
                    const decodedLogSupply = repo.ifaceSupply.parseLog(log);
                    const amount = decodedLogSupply.args.amount;
                    const onBehalfOf = log.topics[3];
                    const topicAddress = log.topics[2];
                    let address = topicAddress; //the actual beneficiary of the supply
                    if (onBehalfOf && onBehalfOf != topicAddress) {
                        address = onBehalfOf; //the actual beneficiary of the supply
                    }
                    if (_.includes(addressesObjectsAddresses, address)) {
                        const reserve = log.topics[1];
                        const userConfiguration =
                            repo.aave[key].addressesObjects[address]
                                .userConfiguration;
                        if (
                            liquidationManager.isReserveUsedAsCollateral(
                                userConfiguration,
                                reserve,
                                key
                            )
                        ) {
                            repo.aave[key].usersReserves[address][
                                reserve
                            ].currentATokenBalance += amount;

                            if (
                                repo.aave[key].usersReserves[address][reserve]
                                    .usageAsCollateralEnabled
                            ) {
                                if (shouldCheckLiquidationOpportunities) {
                                    await liquidationManager.checkLiquidateAddresses(
                                        address,
                                        key
                                    );
                                }
                                await this.updateUserConfiguration(
                                    address,
                                    key
                                );
                            }
                        }
                    }

                    break;

                case "0x44c58d81365b66dd4b1a7f36c25aa97b8c71c361ee4937adc1a00000227db5dd": //ReserveUsedAsCollateralDisabled
                    if (_.includes(addressesObjectsAddresses, log.topics[2])) {
                        const address = log.topics[2];
                        const reserve = log.topics[1];
                        repo.aave[key].usersReserves[address][
                            reserve
                        ].usageAsCollateralEnabled = false;

                        if (shouldCheckLiquidationOpportunities) {
                            await liquidationManager.checkLiquidateAddresses(
                                network,
                                address
                            );
                        }

                        await this.updateUserConfiguration(address, key);
                    }
                    break;

                case "0x00058a56ea94653cdf4f152d227ace22d4c00ad99e2a43f58cb7d9e3feb295f2": //ReserveUsedAsCollateralEnabled
                    if (_.includes(addressesObjectsAddresses, log.topics[2])) {
                        const address = log.topics[2];
                        const reserve = log.topics[1];
                        repo.aave[key].usersReserves[address][
                            reserve
                        ].usageAsCollateralEnabled = true;

                        if (shouldCheckLiquidationOpportunities) {
                            await liquidationManager.checkLiquidateAddresses(
                                network,
                                address
                            );
                        }

                        await this.updateUserConfiguration(address, key);
                    }

                    break;

                case "0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7": //Withdraw
                    const decodedLogWithdraw = repo.ifaceWithdraw.parseLog(log);
                    const amountWithdrawn = decodedLogWithdraw.args.amount;
                    if (_.includes(addressesObjectsAddresses, log.topics[2])) {
                        const reserve = log.topics[1];
                        const userConfiguration =
                            repo.aave[key].addressesObjects[log.topics[2]]
                                .userConfiguration;
                        if (
                            liquidationManager.isReserveUsedAsCollateral(
                                userConfiguration,
                                reserve,
                                key
                            ) &&
                            repo.aave[key].usersReserves[log.topics[2]][reserve]
                                .usageAsCollateralEnabled
                        ) {
                            repo.aave[key].usersReserves[log.topics[2]][
                                reserve
                            ].currentATokenBalance -= amountWithdrawn;

                            if (shouldCheckLiquidationOpportunities) {
                                await liquidationManager.checkLiquidateAddresses(
                                    log.topics[2],
                                    key
                                );
                            }
                            await this.updateUserConfiguration(
                                log.topics[2],
                                key
                            );
                        }
                    }
                    break;

                default:
                    return;
            }
        }
    }

    //#endregion syncInMemoryData

    //#region getUserAccountDataForAddresses

    async getUserAccountDataForAddresses(
        _addresses: string[],
        network: Network
    ) {
        if (!_addresses || _addresses.length == 0) return [];
        const networkInfo = await common.getAaveNetworkInfo(network);

        const userAccountData = await multicallManager.multicall(
            networkInfo.aaveAddresses.pool,
            _addresses,
            "POOL_ABI",
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
    async updateReservesData(context: InvocationContext | null = null) {
        //initialization

        logger.initialize(
            "function:updateReservesData",
            LoggingFramework.ApplicationInsights,
            context
        );

        await logger.log("Start updateReservesData", "functionAppExecution");
        await this.initializeAlchemy();

        for (const aaveNetworkInfo of Constants.AAVE_NETWORKS_INFOS) {
            const key = aaveNetworkInfo.network.toString();

            const results = await multicallManager.multicall(
                aaveNetworkInfo.aaveAddresses.poolDataProvider,
                null,
                "POOL_DATA_PROVIDER_ABI",
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

            const reservetokenAddresses = await multicallManager.multicall(
                aaveNetworkInfo.aaveAddresses.poolDataProvider,
                _.map(allReserveTokens, (o) => o.address),
                "POOL_DATA_PROVIDER_ABI",
                "getReserveTokensAddresses",
                aaveNetworkInfo.network
            );

            //const reservetokenAddresses = results[1][0];
            for (let i = 0; i < reservetokenAddresses.length; i++) {
                allReserveTokens[i].atokenAddress =
                    reservetokenAddresses[i][0].toString();
                allReserveTokens[i].stableDebttokenAddress =
                    reservetokenAddresses[i][1].toString();
                allReserveTokens[i].variableDebttokenAddress =
                    reservetokenAddresses[i][2].toString();
            }

            const allReserveTokensAddresses = _.map(
                allReserveTokens,
                (o) => o.address
            );

            const reservesData1 = await multicallManager.multicall(
                aaveNetworkInfo.aaveAddresses.poolDataProvider,
                allReserveTokensAddresses,
                "POOL_DATA_PROVIDER_ABI",
                "getReserveData",
                aaveNetworkInfo.network
            );

            for (let i = 0; i < reservesData1.length; i++) {
                allReserveTokens[i].liquidityIndex =
                    reservesData1[i][9].toString();
                allReserveTokens[i].variableBorrowIndex =
                    reservesData1[i][10].toString();
                allReserveTokens[i].liquidityRate =
                    reservesData1[i][5].toString();
                allReserveTokens[i].variableBorrowRate =
                    reservesData1[i][6].toString();
                allReserveTokens[i].totalStableDebt =
                    reservesData1[i][3].toString();
                allReserveTokens[i].lastUpdateTimestamp =
                    reservesData1[i][11].toString();
                allReserveTokens[i].totalVariableDebt =
                    reservesData1[i][4].toString();
            }

            const reservesConfigData = await multicallManager.multicall(
                aaveNetworkInfo.aaveAddresses.poolDataProvider,
                allReserveTokensAddresses,
                "POOL_DATA_PROVIDER_ABI",
                "getReserveConfigurationData",
                aaveNetworkInfo.network
            );

            //update reserves liquidationProtocolFee
            const liquidationProtocolFees = await multicallManager.multicall(
                aaveNetworkInfo.aaveAddresses.poolDataProvider,
                allReserveTokensAddresses,
                "POOL_DATA_PROVIDER_ABI",
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
                allReserveTokens[i].borrowingEnabled =
                    sqlManager.getBitFromBoolean(reservesConfigData[i][6]);
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
            let reservesSQLList: string[] = _.map(
                allReserveTokens,
                (o, index) => {
                    return `('${o.address}', '${key}', '${o.symbol}', ${
                        o.decimals
                    }, '${o.reserveLiquidationThreshold}', '${
                        o.reserveLiquidationBonus
                    }', '${o.reserveFactor}', ${
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
                    }', '${o.variableBorrowRate}', '${
                        o.lastUpdateTimestamp
                    }', '${o.atokenAddress}','${
                        o.variableDebttokenAddress
                    }', '${o.stableDebttokenAddress}', '${
                        o.totalStableDebt
                    }', '${o.totalVariableDebt}', '${
                        o.ltv
                    }', ${index}, GETUTCDATE())`;
                }
            );

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

                await this.triggerWebServerAction("updateReserves", key);
            }
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
    async updateUserAccountDataAndUsersReserves(
        context: InvocationContext | null = null
    ) {
        //initialization
        logger.initialize(
            "function:updateUserAccountDataAndUsersReserves",
            LoggingFramework.ApplicationInsights,
            context
        );

        await logger.log(
            "Start updateUserAccountDataAndUsersReserves",
            "functionAppExecution"
        );

        await this.initializeAlchemy();
        await this.initializeReserves();
        await this.initializeAddresses();

        for (const aaveNetworkInfo of Constants.AAVE_NETWORKS_INFOS) {
            const key = aaveNetworkInfo.network.toString();
            let dbAddressesArr: any[];
            let deleteAddressesQueries: string[] = [];
            let offset = 0;
            do {
                dbAddressesArr = await sqlManager.execQuery(
                    `SELECT * FROM addresses WHERE network = '${key}'
                     ORDER BY addedOn OFFSET ${offset} ROWS FETCH NEXT ${Constants.CHUNK_SIZE} ROWS ONLY
                `
                );

                if (dbAddressesArr.length == 0) break;
                offset += Constants.CHUNK_SIZE;
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

                //Save data to the DB:
                //NOTE: it is not necessary to save the totalDebtBase to the DB, since
                //it will be calculated anyway from the usersReserves data.
                //I leave it here anyway for now, since it is not a big deal to save it
                const chunks = _.chunk(results, Constants.CHUNK_SIZE);
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
                    const chunks = _.chunk(
                        deleteAddresses,
                        Constants.CHUNK_SIZE
                    );
                    for (let i = 0; i < chunks.length; i++) {
                        const sqlQuery = `
                    DELETE FROM addresses WHERE address IN ('${chunks[i].join(
                        "','"
                    )}') AND network = '${key}';
                    DELETE FROM usersReserves WHERE address IN ('${chunks[
                        i
                    ].join("','")}') AND network = '${key}';
                    `;
                        deleteAddressesQueries.push(sqlQuery);
                    }
                }
            } while (dbAddressesArr.length > 0);

            for (const deleteAddressesQuery of deleteAddressesQueries) {
                await sqlManager.execQuery(deleteAddressesQuery);
            }

            await this.triggerWebServerAction("updateUsersReserves", key);
        }

        await logger.log(
            "End updateUserAccountDataAndUsersReserves",
            "functionAppExecution"
        );
    }

    //#endregion updateUserAccountDataAndUserReserves

    //#region updateGasPrice

    async updateGasPrice(context: InvocationContext | null = null) {
        logger.initialize(
            "function:updateGasPrice",
            LoggingFramework.ApplicationInsights,
            context
        );
        await this.initializeAlchemy();
        for (const aaveNetworkInfo of Constants.AAVE_NETWORKS_INFOS) {
            await this.triggerWebServerAction(
                "updateGasPrice",
                aaveNetworkInfo.network
            );
        }
        await logger.log("End updateGasPrice", "functionAppExecution");
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
        logger.initialize(
            "function:updateReservesPrices",
            LoggingFramework.ApplicationInsights,
            context
        );
        await logger.log("Start updateReservesPrices");

        await this.initializeAlchemy();
        await this.initializeReserves(network);

        //load all addresses from the DB that have health factor < 2 since higher health factors are not interesting
        const allAddressesDb = await sqlManager.execQuery(
            `SELECT * FROM addresses WHERE healthFactor < 2 ORDER BY healthFactor;`
        );

        if (allAddressesDb.length == 0) {
            await logger.log("No addresses found in DB with health factor < 2");
            return;
        }

        for (const aaveNetworkInfo of Constants.AAVE_NETWORKS_INFOS) {
            if (network && network != aaveNetworkInfo.network) continue;

            const key = aaveNetworkInfo.network.toString();
            const addressesDb = _.filter(
                allAddressesDb,
                (o) => o.network == key
            );

            if (addressesDb.length == 0) {
                await logger.log(
                    `Network: ${key} No addresses found in DB with health factor < 2`
                );
                return;
            }

            //get last saved reserves prices from the DB
            let dbAssetsPrices = common.getJsonObjectFromArray(
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

            //by default we should not perform the check. If price changes are found, we do check
            let reservesChangedCheck: any[] = [];
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

                let check = "none";

                //if the normalized change is greater than the given treshold (for now 0.5 USD), we should perform the check
                if (Math.abs(normalizedChange) > 0.5) {
                    //mark current reserve to be updated in the DB since the change exceeds the treshold
                    reservesDbUpdate.push({
                        address: reserveAddress,
                        price: newPrice,
                    });

                    //add current reserve to the list of changed reserves and check if it should be checked as collateral or a debt
                    check = normalizedChange < 0 ? "collateral" : "debt";
                }

                //add the reserve to the list of changed reserves. If no price change for this reserve has happened, the check will be "none"
                reservesChangedCheck.push({
                    reserve: reserveAddress,
                    check: check,
                });
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
        logger.initialize(
            "function:deleteOldTablesEntries",
            LoggingFramework.ApplicationInsights,
            context
        );
        await logger.log("Started function deleteOldTablesEntries");
        const query = `
            DELETE FROM dbo.logs WHERE timestamp < DATEADD(DAY, -2, GETUTCDATE());            
        `;
        await sqlManager.execQuery(query);
        await logger.log("Ended function deleteOldTablesEntries");
    }

    //#endregion Function: deleteOldTablesEntries

    //#endregion Scheduled azure functions

    //#region #Testing

    async doTest() {
        console.log(Network.ARB_MAINNET.toString());
    }

    //#endregion Testing methods
}

export default Engine.getInstance();
