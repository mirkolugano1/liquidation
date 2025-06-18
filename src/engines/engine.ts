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
import fileManager from "../managers/fileManager";

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
                    `@status:[1 1] @networkNormalized:{${common.normalizeRedisKey(
                        key
                    )}}`,
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
                        `@networkNormalized:{${common.normalizeRedisKey(
                            key
                        )}} @address:{${addressList}}`,
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

                //Note: this is no longer useful
                /*
                //set status to 2 for all addresses that have been loaded
                _.each(queryAddresses, (o) => {
                    o.status = 2;
                });
                await redisManager.setArrayProperties(queryAddresses, "status");
                */
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

            if (!dbReserves || dbReserves.length == 0) continue;

            const networkReserves = _.filter(dbReserves, { network: key });
            for (let networkReserve of networkReserves) {
                reserves[networkReserve.address] = networkReserve;
            }
            repo.aave[key].reserves = reserves;
        }
    }

    //#endregion initializeReserves

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

    //#region convertFieldValueToInteger

    /**
     * Converts the field value to an integer if it is not null
     * @param item the item to convert
     * @param fieldName the field name to convert
     * @returns the item with the field value converted to an integer
     */

    convertFieldValueToInteger(item: any, fieldName: string) {
        if (item[fieldName] != null) {
            item[fieldName] = parseInt(item[fieldName]);
        }
        return item;
    }

    //#endregion convertFieldValueToInteger

    //#region updateUserConfiguration

    async updateUserProperties(
        addressesObjects: any[],
        network: Network | string
    ): Promise<any[]> {
        if (!addressesObjects || addressesObjects.length == 0) return [];
        const addresses = _.map(addressesObjects, (o) => o.address);
        const aaveNetworkInfo = common.getAaveNetworkInfo(network);
        const userConfigurations = await transactionManager.multicall(
            aaveNetworkInfo.aaveAddresses.pool,
            addresses,
            Constants.ABIS.POOL_ABI,
            "getUserConfiguration",
            aaveNetworkInfo.network
        );
        const eModes = await transactionManager.multicall(
            aaveNetworkInfo.aaveAddresses.pool,
            addresses,
            Constants.ABIS.POOL_ABI,
            "getUserEMode",
            aaveNetworkInfo.network
        );

        for (let i = 0; i < addressesObjects.length; i++) {
            const userConfiguration = new Big(userConfigurations[i])
                .toNumber()
                .toString(2);
            addressesObjects[i].userConfiguration = userConfiguration;
            addressesObjects[i].eMode = eModes[i];
            addressesObjects[i].status = 1;
        }

        return addressesObjects;
    }

    //#endregion updateUserConfiguration

    //#region updateUserEMode

    async updateUserEMode(
        addresses: string | string[],
        network: Network | string
    ) {
        if (!Array.isArray(addresses)) addresses = [addresses];
        const aaveNetworkInfo = common.getAaveNetworkInfo(network);
        const userConfigurations = await transactionManager.multicall(
            aaveNetworkInfo.aaveAddresses.pool,
            addresses,
            Constants.ABIS.POOL_ABI,
            "getUserEMode",
            aaveNetworkInfo.network
        );

        const addressList = addresses.join("|");
        const addressesToUpdate: any = await redisManager.call(
            "FT.SEARCH",
            "idx:addresses",
            `@networkNormalized:{${common.normalizeRedisKey(
                aaveNetworkInfo.network.toString()
            )}} @address:{${addressList}}`
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

    //#endregion updateUserEMode

    //#region updateUsersReservesData

    async updateUsersReservesData(
        userAddressesObjects: any[],
        aaveNetworkInfo: any
    ) {
        if (!userAddressesObjects || userAddressesObjects.length == 0) return;
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

        const userReservesObjects = _.map(results, (userReserveData, i) => {
            const userAddress =
                multicallUserReserveDataParameters[i][1].toString();
            const reserveAddress =
                multicallUserReserveDataParameters[i][0].toString();
            return {
                network: key,
                networkNormalized: common.normalizeRedisKey(key),
                tokenAddress: reserveAddress,
                userAddress: userAddress,
                currentATokenBalance: userReserveData[0].toString(),
                currentStableDebt: userReserveData[1].toString(),
                currentVariableDebt: userReserveData[2].toString(),
                principalStableDebt: userReserveData[3].toString(),
                scaledVariableDebt: userReserveData[4].toString(),
                stableBorrowRate: userReserveData[5].toString(),
                liquidityRate: userReserveData[6].toString(),
                stableRateLastUpdated: userReserveData[7].toString(),
                usageAsCollateralEnabled: sqlManager.getBitFromBoolean(
                    userReserveData[8].toString()
                ),
            };
        });

        const allUserReserveObjectsAddresses = _.uniq(
            _.map(userReservesObjects, (o) => o.userAddress)
        );
        const liquidatableUserAddressObjects = _.filter(
            userAddressesObjects,
            (o) =>
                o.healthFactor < 1 &&
                _.includes(allUserReserveObjectsAddresses, o.address)
        );

        if (liquidatableUserAddressObjects.length > 0) {
            const liquidatableUserAddressObjectsAddresses = _.map(
                liquidatableUserAddressObjects,
                (o) => o.address
            );
            const liquidatableUserReserves = _.filter(
                userReservesObjects,
                (o) =>
                    liquidatableUserAddressObjectsAddresses.includes(
                        o.userAddress
                    )
            );

            await liquidationManager.checkLiquidateAddressesFromInMemoryObjects(
                aaveNetworkInfo,
                liquidatableUserAddressObjects,
                liquidatableUserReserves
            );
        }

        //save data to redis
        const redisUserReservesKeys = _.map(
            userReservesObjects,
            (o: any) =>
                `usersReserves:${key}:${o.userAddress}:${o.tokenAddress}`
        );
        await redisManager.set(redisUserReservesKeys, userReservesObjects);
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

    //#region getReservePriceOracleAggregatorAddresses

    async getReservePriceOracleAggregatorAddresses(
        aaveNetworkInfo: any,
        reservesAddresses: string[] = []
    ) {
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

            aggregators.push(aggregatorAddress.toLowerCase());
        }

        return aggregators;
    }

    //#endregion getReservePriceOracleAggregatorAddresses

    //#endregion Helper methods

    //#region #Scheduled azure functions

    //
    //
    //
    // space to allow regions to be displayed correctly in VSCode
    //
    //
    //

    //#region updateEModeCategoryData

    async updateEModeCategoryData(aaveNetworkInfo: any) {
        const pool = common.getContract(
            aaveNetworkInfo.aaveAddresses.pool,
            Constants.ABIS.POOL_ABI,
            aaveNetworkInfo.network
        );

        let eModeCategory = 0;
        let hasCategoryData = true;
        let redisKeysEModeCategoryData: string[] = [];
        let redisValuesEModeCategoryData: any[] = [];
        const aaveOracleContract = common.getContract(
            aaveNetworkInfo.aaveAddresses.aaveOracle,
            Constants.ABIS.AAVE_ORACLE_ABI,
            aaveNetworkInfo.network
        );
        while (hasCategoryData) {
            eModeCategory++;
            try {
                const _eModeCategoryData = await pool.getEModeCategoryData(
                    eModeCategory
                );

                let eModePrice = 0;
                if (_eModeCategoryData[3] !== Constants.ZERO_ADDRESS) {
                    eModePrice = await aaveOracleContract.getAssetPrice(
                        _eModeCategoryData[3]
                    );
                }
                const eModeCategoryData: any = {
                    ltv: _eModeCategoryData[0].toString(),
                    liquidationThreshold: _eModeCategoryData[1].toString(),
                    liquidationBonus: _eModeCategoryData[2].toString(),
                    priceSource: _eModeCategoryData[3].toString(),
                    eModePrice: eModePrice.toString(),
                };

                redisKeysEModeCategoryData.push(
                    `eModeCategoryData:${aaveNetworkInfo.network.toString()}:${eModeCategory}`
                );
                redisValuesEModeCategoryData.push(eModeCategoryData);
            } catch (error) {
                hasCategoryData = false;
                continue;
            }
        }

        const pipeline = redisManager.redisClient.multi();
        for (let i = 0; i < redisKeysEModeCategoryData.length; i++) {
            const key = redisKeysEModeCategoryData[i];
            const value = redisValuesEModeCategoryData[i];
            pipeline.call("JSON.SET", key, "$", JSON.stringify(value));
        }
        for (let i = eModeCategory; i < 100; i++) {
            pipeline.del(
                `eModeCategoryData:${aaveNetworkInfo.network.toString()}:${i}`
            );
        }
        await pipeline.exec();
    }

    //#endregion updateEModeCategoryData

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

        //update eMode category data
        await this.updateEModeCategoryData(aaveNetworkInfo);

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
                networkNormalized: common.normalizeRedisKey(key),
                symbol: o[0].toString(),
                address: o[1].toString(),
            };
        });

        const allReserveTokensAddresses = _.map(
            allReserveTokens,
            (o) => o.address
        );

        const reserveTokenAddress = await transactionManager.multicall(
            aaveNetworkInfo.aaveAddresses.poolDataProvider,
            allReserveTokensAddresses,
            Constants.ABIS.POOL_DATA_PROVIDER_ABI,
            "getReserveTokensAddresses",
            aaveNetworkInfo.network
        );

        const eModeCategoryResults = await transactionManager.multicall(
            aaveNetworkInfo.aaveAddresses.poolDataProvider,
            allReserveTokensAddresses,
            Constants.ABIS.POOL_DATA_PROVIDER_ABI,
            "getReserveEModeCategory",
            aaveNetworkInfo.network
        );

        //const reserveTokenAddress = results[1][0];
        for (let i = 0; i < reserveTokenAddress.length; i++) {
            allReserveTokens[i].eModeCategory =
                eModeCategoryResults[i][0].toString();
            allReserveTokens[i].aTokenAddress =
                reserveTokenAddress[i][0].toString();
            allReserveTokens[i].stableDebtTokenAddress =
                reserveTokenAddress[i][1].toString();
            allReserveTokens[i].variableDebtTokenAddress =
                reserveTokenAddress[i][2].toString();
        }

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
            allReserveTokens[i].decimals = reservesConfigData[i][0].toString();
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

        if (allReserveTokens.length > 0) {
            _.each(allReserveTokens, (o) => {
                o.modifiedOn = moment().utc().unix();
            });
            const reservesKeys = _.map(
                allReserveTokens,
                (o) => `reserves:${o.network}:${o.address}`
            );

            //get price oracle aggregators for reserves (if changed)
            const aggregators =
                await this.getReservePriceOracleAggregatorAddresses(
                    aaveNetworkInfo,
                    allReserveTokensAddresses
                );

            if (aggregators.length > 0) {
                for (let i = 0; i < aggregators.length; i++) {
                    allReserveTokens[i].priceOracleAggregatorAddress =
                        aggregators[i];
                }
            }

            const aggregatorsMappings = _.map(allReserveTokens, (o) => ({
                address: o.address,
                priceOracleAggregatorAddress: o.priceOracleAggregatorAddress,
            }));
            const aggregatorsMappingsWithAggregatorDefined: any[] = _.filter(
                aggregatorsMappings,
                (o) => o.priceOracleAggregatorAddress
            );
            //fetch and save aggregators decimals
            const aggregatorsDecimals = await transactionManager.multicall(
                _.map(
                    aggregatorsMappingsWithAggregatorDefined,
                    "priceOracleAggregatorAddress"
                ),
                null,
                Constants.ABIS.AGGREGATOR_ABI,
                "decimals",
                aaveNetworkInfo.network
            );
            for (let i = 0; i < aggregatorsDecimals.length; i++) {
                const tokenAddress =
                    aggregatorsMappingsWithAggregatorDefined[i].address;
                const indexOfToken = _.findIndex(
                    allReserveTokens,
                    (o) => o.address === tokenAddress
                );
                if (indexOfToken >= 0) {
                    allReserveTokens[
                        indexOfToken
                    ].priceOracleAggregatorDecimals =
                        aggregatorsDecimals[i][0].toString();
                }
            }

            //save to redis
            await redisManager.set(reservesKeys, allReserveTokens);
        }
    }

    //#endregion updateReservesData

    //#region updateUserAccountDataAndUserReserves

    async updateUserAccountDataAndUsersReserves_initialization(
        context: InvocationContext | null = null
    ) {
        await this.initializeAlchemy();
        await this.initializeReserves();
        await this.initializeAddresses();

        //set status to null for all addresses in the DB
        //this will allow to update the userAccountData and userReserves for all addresses
        const utcNow = moment().utc().unix();
        await redisManager.set(
            "config:lastUpdateUserAccountDataAndUsersReserves",
            utcNow
        );

        const allAddresses = await redisManager.getList(`addresses:*`);
        _.each(allAddresses, (address) => (address.status = null));
        await redisManager.setArrayProperties(allAddresses, "status");
    }
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
        network: Network
    ) {
        logger.initialize(
            "function:updateUserAccountDataAndUsersReserves",
            context
        );
        await logger.log(
            `Start updateUserAccountDataAndUsersReserves_chunk for network ${network}`
        );

        const key = network.toString();
        const aaveNetworkInfo = await common.getAaveNetworkInfo(network);
        const timestamp = await redisManager.getValue(
            "config:lastUpdateUserAccountDataAndUsersReserves"
        );

        const query = `@networkNormalized:{${common.normalizeRedisKey(
            key
        )}} @status:[0 0] @addedOn:[-inf ${timestamp}]`;
        const dbAddressesArr = await redisManager.call(
            "FT.SEARCH",
            "idx:addresses",
            query,
            "SORTBY",
            "addedOn",
            "ASC",
            "LIMIT",
            "0",
            Constants.CHUNK_SIZE.toString()
        );

        const hasData: boolean = dbAddressesArr.length > 0;
        if (hasData) {
            const _addresses = _.map(dbAddressesArr, (a: any) => a.address);

            const results = await this.getUserAccountDataForAddresses(
                _addresses,
                aaveNetworkInfo.network
            );

            const userAccountDataHFGreaterThan2 = _.filter(results, (o) => {
                return o.healthFactor > 2;
            });
            let addressesUserAccountDataHFLowerThan2 = _.filter(
                results,
                (o) => {
                    return o.healthFactor <= 2;
                }
            );

            if (addressesUserAccountDataHFLowerThan2.length > 0) {
                //update userConfiguration, userEMode, status for addresses with health factor < 2
                addressesUserAccountDataHFLowerThan2 =
                    await this.updateUserProperties(
                        addressesUserAccountDataHFLowerThan2,
                        aaveNetworkInfo.network
                    );

                await this.updateUsersReservesData(
                    addressesUserAccountDataHFLowerThan2,
                    aaveNetworkInfo
                );
            }

            //Save data to the DB:
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
        return hasData; //return true if there are more addresses to process, false otherwise
    }

    //#endregion updateUserAccountDataAndUserReserves

    //#region updateGasPrice

    async updateGasPrice(context: InvocationContext | null = null) {
        logger.initialize("function:updateGasPrice", context);
        await this.initializeAlchemy();

        for (const aaveNetworkInfo of common.getNetworkInfos()) {
            const gasPrice = await aaveNetworkInfo.alchemy.core.getGasPrice();
            await redisManager.set(
                `gasPrice:${aaveNetworkInfo.network}`,
                gasPrice.toString()
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
    async updateReservesPrices_loop(
        context: InvocationContext | null = null,
        network: Network
    ) {
        const aaveNetworkInfo = common.getAaveNetworkInfo(network);
        const key = aaveNetworkInfo.network.toString();

        //get current reserves prices from the network
        const aaveOracleContract = common.getContract(
            aaveNetworkInfo.aaveAddresses.aaveOracle,
            Constants.ABIS.AAVE_ORACLE_ABI,
            aaveNetworkInfo.network
        );
        const reservesAddresses = Object.keys(aaveNetworkInfo.reserves);
        const currentAssetsPrices = await aaveOracleContract.getAssetsPrices(
            reservesAddresses
        );

        let newReservesPrices: any = {};
        for (let i = 0; i < reservesAddresses.length; i++) {
            const reserveAddress = reservesAddresses[i];
            const price = currentAssetsPrices[i];
            newReservesPrices[reserveAddress] = price;
        }

        let reservesDbUpdate: any[] = [];
        for (const reserveAddress of reservesAddresses) {
            const oldPrice = aaveNetworkInfo.reserves[reserveAddress];
            const reservePriceOracleAggregatorDecimals =
                aaveNetworkInfo.reserves[
                    reserveAddress
                ].priceOracleAggregatorDecimals.toString();
            const newPrice =
                new Big(newReservesPrices[reserveAddress]).toNumber() /
                (reservePriceOracleAggregatorDecimals ?? 0); //USD has 8 decimals
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
            const priceUpdateReservesKeys = _.map(
                reservesDbUpdate,
                (o) => `reserves:${key}:${o.address}`
            );

            //todo evtl just save price and priceModifiedOn to redis without loading the whole object from redis?
            const priceUpdateReserves: any =
                await redisManager.redisClient.call(
                    "JSON.MGET",
                    ...priceUpdateReservesKeys,
                    "$"
                );

            const priceUpdateReservesObjects = _.map(
                priceUpdateReserves,
                (o) => {
                    let obj = JSON.parse(o)[0];
                    return {
                        ...obj,
                        key: `reserves:${key}:${obj.address}`,
                        priceModifiedOn: moment.utc().unix(),
                    };
                }
            );

            await redisManager.setArrayProperties(priceUpdateReservesObjects, [
                "price",
                "priceModifiedOn",
            ]);
        }

        await logger.log("updateReservesPrices: End");
    }

    async updateReservesPrices_initialization(
        context: InvocationContext | null = null,
        network: Network | null = null //if network is not defined, loop through all networks
    ) {
        logger.initialize("function:updateReservesPrices", context);
        await logger.log("updateReservesPrices: Start");

        await this.initializeAlchemy(network);
        await this.initializeReserves(network);
    }

    //#endregion updateReservesPrices

    //#endregion Scheduled azure functions

    //#region #Testing

    async migrateDataToRedis() {
        //migrate data from SQL to Redis

        console.log("deleting all data from redis");
        await redisManager.deleteAllData();

        console.log("(re)creating Redis indexes...");
        await redisManager.createRedisIndexes();

        console.log("migrating data from SQL to Redis...");
        let result = await sqlManager.execQuery("Select * from config");
        let keys = _.map(result, (o) => `config:${o.key}`);
        await redisManager.set(
            keys,
            _.map(result, (o) => o.value)
        );

        result = await sqlManager.execQuery("Select * from addresses");
        _.each(result, (o) => {
            o.status = 0;
            if (o.addedOn) o.addedOn = moment(o.addedOn).unix();
            if (o.modifiedOn) o.modifiedOn = moment(o.modifiedOn).unix();
            o.networkNormalized = common.normalizeRedisKey(o.network);
        });
        keys = _.map(result, (o) => `addresses:${o.network}:${o.address}`);
        await redisManager.set(keys, result);

        result = await sqlManager.execQuery("Select * from reserves");
        _.each(result, (o) => {
            o.networkNormalized = common.normalizeRedisKey(o.network);
            o = this.convertFieldValueToInteger(o, "reserveLiquidationBonus");
            o = this.convertFieldValueToInteger(
                o,
                "reserveLiquidationThreshold"
            );
            o = this.convertFieldValueToInteger(o, "reserveFactor");
            o = this.convertFieldValueToInteger(o, "decimals");
            o = this.convertFieldValueToInteger(o, "liquidityIndex");
            o = this.convertFieldValueToInteger(o, "variableBorrowIndex");
            o = this.convertFieldValueToInteger(o, "liquidityRate");
            o = this.convertFieldValueToInteger(o, "variableBorrowRate");
            o = this.convertFieldValueToInteger(o, "totalStableDebt");
            o = this.convertFieldValueToInteger(o, "totalVariableDebt");
            o = this.convertFieldValueToInteger(o, "lastUpdateTimestamp");
            o = this.convertFieldValueToInteger(o, "liquidationProtocolFee");
            o = this.convertFieldValueToInteger(o, "ltv");

            o.priceOracleAggregatorAddress =
                o.priceOracleAggregatorAddress?.toLowerCase();
        });
        keys = _.map(result, (o) => `reserves:${o.network}:${o.address}`);
        await redisManager.set(keys, result);

        console.log("successfully migrated data to redis");
    }

    async doTest() {
        //await redisManager.createRedisIndexes(true);
        //await this.migrateDataToRedis();

        await this.initializeAlchemy();

        const aaveNetworkInfo1 = common.getAaveNetworkInfo(Network.ARB_MAINNET);
        await this.initializeReserves();

        logger.initialize("function:doTest", null);
        const address = "0x02d722f73a59d51d845ae9972b28d28b4b795c65";
        await this.initializeAlchemy();
        await this.initializeAddresses();
        await this.updateReservesData_loop(null, Network.ARB_MAINNET);
        return;
        await this.initializeReserves();
        await this.updateReservesPrices_loop(null, Network.ARB_MAINNET);
        await this.initializeReserves();
        const aaveNetworkInfo = common.getAaveNetworkInfo(Network.ARB_MAINNET);
        const uad = await transactionManager.multicall(
            aaveNetworkInfo.aaveAddresses.pool,
            address,
            Constants.ABIS.POOL_ABI,
            "getUserAccountData",
            aaveNetworkInfo.network
        );
        console.log("Collateral from Chain", Number(uad[0][0]) / 10 ** 8);

        const uao = await redisManager.getObject(
            `addresses:${aaveNetworkInfo.network}:${address}`
        );
        await this.updateUsersReservesData([uao], aaveNetworkInfo);

        const userReserves = await redisManager.getList(
            `usersReserves:${aaveNetworkInfo.network}:${address}:*`
        );
        const tcb = liquidationManager.calculateTotalCollateralBaseForAddress(
            address,
            aaveNetworkInfo,
            userReserves
        );
        console.log("Collateral Calculated", tcb);

        return;

        await this.updateUserAccountDataAndUsersReserves_initialization();
        for (const aaveNetworkInfo of common.getNetworkInfos()) {
            let hasMoreData = true;
            while (hasMoreData) {
                hasMoreData =
                    await this.updateUserAccountDataAndUsersReserves_chunk(
                        null,
                        aaveNetworkInfo.network
                    );
            }
        }

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
