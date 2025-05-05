//#region #Imports

import common from "../shared/common";
import _ from "lodash";
import moment from "moment";
import encryption from "../managers/encryptionManager";
import sqlManager from "../managers/sqlManager";
import { ethers, formatUnits } from "ethers";
import Big from "big.js";
import logger from "../shared/logger";
import { InvocationContext } from "@azure/functions";
import { LoggingFramework, LogType } from "../shared/enums";
import Constants from "../shared/constants";
import { Alchemy, Network } from "alchemy-sdk";
import emailManager from "../managers/emailManager";
import axios from "axios";
import { r } from "tar";

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
        if (this.isWebServerInitialized) return;

        this.ifaceBorrow = new ethers.Interface(
            Constants.ABIS.BORROW_EVENT_ABI
        );
        this.ifaceDeposit = new ethers.Interface(
            Constants.ABIS.DEPOSIT_EVENT_ABI
        );
        this.ifaceSupply = new ethers.Interface(
            Constants.ABIS.SUPPLY_EVENT_ABI
        );
        this.ifaceWithdraw = new ethers.Interface(
            Constants.ABIS.WITHDRAW_EVENT_ABI
        );
        this.ifaceLiquidationCall = new ethers.Interface(
            Constants.ABIS.LIQUIDATION_CALL_EVENT_ABI
        );
        this.ifaceRepay = new ethers.Interface(Constants.ABIS.REPAY_EVENT_ABI);
        this.ifaceFlashLoan = new ethers.Interface(
            Constants.ABIS.FLASHLOAN_EVENT_ABI
        );

        await this.initializeAlchemy();
        await this.initializeAddresses();
        await this.initializeReserves();
        await this.initializeUsersReserves();
        await this.initializeGasPrice();

        this.isWebServerInitialized = true;
    }

    //#endregion initializeWebServer

    //#region initializeWebServerUrl

    async initializeWebServerUrl() {
        if (this.webappUrl) return;
        this.webappUrl = await common.getAppSetting("WEBAPPURL");
    }

    //#endregion initializeWebServerUrl

    //#region initializeAddresses

    async initializeAddresses() {
        const initAddresses = await sqlManager.execQuery(
            "SELECT * FROM addresses"
        );
        for (const address of initAddresses) {
            if (!this.aave[address.network].hasOwnProperty("addresses"))
                this.aave[address.network].addresses = [];
            this.aave[address.network].addresses.push(address.address);

            if (!this.aave[address.network].hasOwnProperty("addressesObjects"))
                this.aave[address.network].addressesObjects = {};
            this.aave[address.network].addressesObjects[address.address] =
                address;
        }
    }

    //#endregion initializeAddresses

    //#region initializeUsersReserves

    async initializeUsersReserves(network: Network | null = null) {
        if (!this.aave) throw new Error("Aave object not initialized");
        const _key = network?.toString() ?? null;
        let query = `SELECT * FROM usersreserves`;
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
                    networkUserReserves.tokenaddress
                ] = networkUserReserves;
            }
            this.aave[key] = _.assign(aaveNetworkInfo, {
                usersReserves: usersReserves,
            });

            //calculate "external" collateral for all users in case of credit delegation in order to
            // take it into account when receiving events from Alchemy
            for (let i = 0; i < this.aave[key].addresses.length; i++) {
                const address = this.aave[key].addresses[i];
                if (!this.aave[key].usersReserves[address]) continue;
                const userReserves = this.aave[key].usersReserves[address];
                const externalCollateral = userReserves.reduce(
                    (total: any, userReserve: any) => {
                        return total + userReserve.currentATokenBalance;
                    },
                    0
                );

                this.aave[key].addressesObjects[address].externalCollateral =
                    externalCollateral;
            }
        }
    }

    //#endregion initializeUsersReserves

    //#region initializeReserves

    async initializeReserves(network: Network | null = null) {
        if (!this.aave) throw new Error("Aave object not initialized");
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
            this.aave[key] = _.assign(aaveNetworkInfo, { reserves: reserves });
        }
    }

    //#endregion initializeReserves

    //#region initializeAlchemy

    async initializeAlchemy() {
        if (this.aave) return;
        this.aave = {};

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

            this.aave[key] = networkInfo;

            const addresses = await this.multicall(
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

    aave: any;
    contractInterfaces: any = {};

    triggerWebServerActionDevDisabled: boolean = true;
    webappUrl: string = "";
    isWebServerInitialized: boolean = false;
    batchAddressesTreshold: number = 25;

    ifaceBorrow: any;
    ifaceDeposit: any;
    ifaceSupply: any;
    ifaceWithdraw: any;
    ifaceLiquidationCall: any;
    ifaceRepay: any;
    ifaceFlashLoan: any;

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
        const aaveNetworkInfo = this.getAaveNetworkInfo(network);
        const userConfigurations = await this.multicall(
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

            this.aave[network].addressesObjects[userAddress].userConfiguration =
                userConfiguration;

            ucQuery += `WHEN address = '${userAddress}' THEN '${userConfiguration}' `;
        }
        ucQuery += `ELSE userConfiguration END WHERE address IN ('${addresses.join(
            "','"
        )}');`;
        await sqlManager.execQuery(ucQuery);
    }

    //#endregion updateUserConfiguration

    //#region initializeGasPrice

    async initializeGasPrice(network: Network | null = null) {
        if (!this.aave) throw new Error("Aave object not initialized");
        for (const aaveNetworkInfo of Constants.AAVE_NETWORKS_INFOS) {
            if (network && network != aaveNetworkInfo.network) continue;
            const gasPrice = await aaveNetworkInfo.alchemy.core.getGasPrice();
            this.aave[aaveNetworkInfo.network].gasPrice = gasPrice;
        }
    }

    //#endregion initializeGasPrice

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

        const results = await this.multicall(
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
                if (!this.aave[key].hasOwnProperty("usersReserves"))
                    this.aave[key].usersReserves = {};
                for (let i = 0; i < allUserReserveObjects.length; i++) {
                    const userReservesObject = allUserReserveObjects[i];
                    if (
                        !this.aave[key].hasOwnProperty(
                            userReservesObject.userAddress
                        )
                    )
                        this.aave[key].usersReserves[
                            userReservesObject.userAddress
                        ] = [];
                    this.aave[key].usersReserves[
                        userReservesObject.userAddress
                    ].push(userReservesObject);
                }

                let sqlQuery = `                        
                        MERGE INTO usersreserves AS target
                        USING (VALUES 
                            ${_.map(
                                userReservesObjects,
                                (o) =>
                                    `('${o.userAddress}', '${o.tokenAddress}', '${key}', '${o.currentATokenBalance}', '${o.currentStableDebt}', '${o.currentVariableDebt}', '${o.principalStableDebt}', '${o.scaledVariableDebt}', '${o.stableBorrowRate}', '${o.liquidityRate}', '${o.stableRateLastUpdated}', ${o.usageAsCollateralEnabled}, GETUTCDATE())`
                            ).join(",")}
                        ) AS source (address, tokenaddress, network, currentATokenBalance, currentStableDebt, currentVariableDebt, principalStableDebt, scaledVariableDebt, stableBorrowRate, liquidityRate, stableRateLastUpdated, usageAsCollateralEnabled, modifiedOn)
                        ON (target.address = source.address AND target.tokenaddress = source.tokenaddress AND target.network = source.network)
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
                        INSERT (address, tokenaddress, network, currentATokenBalance, currentStableDebt, currentVariableDebt, principalStableDebt, scaledVariableDebt, stableBorrowRate, liquidityRate, stableRateLastUpdated, usageAsCollateralEnabled, modifiedOn)
                        VALUES (source.address, source.tokenaddress, source.network, source.currentATokenBalance, source.currentStableDebt, source.currentVariableDebt, source.principalStableDebt, source.scaledVariableDebt, source.stableBorrowRate, source.liquidityRate, source.stableRateLastUpdated, source.usageAsCollateralEnabled, source.modifiedOn);
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

        await this.checkLiquidateAddressesFromInMemoryObjects(
            key,
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

    //#region isReserveUsedAsCollateral

    isReserveUsedAsCollateral(
        userConfiguration: string,
        reserveAddress: string,
        network: Network | string
    ) {
        // Find the index of the reserve in the reserves list
        const reservesList = this.aave[network].reservesList;
        const reserveIndex = reservesList.indexOf(reserveAddress.toLowerCase());
        if (reserveIndex === -1) {
            throw new Error("Reserve address not found in the reserves list.");
        }

        // Convert the userConfiguration to a BigInt for bitwise operations
        const userConfigBigInt = BigInt(userConfiguration);

        // Calculate the position of the collateral bit for the reserve
        const collateralBitPosition = reserveIndex * 2; // Each reserve has 2 bits (collateral and borrow)

        // Check if the collateral bit is set (1) or not (0)
        const isCollateral =
            (userConfigBigInt >> BigInt(collateralBitPosition)) & BigInt(1);

        // Return true if the collateral bit is 1, false otherwise
        return isCollateral === BigInt(1);
    }

    //#endregion isReserveUsedAsCollateral

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

    //#region calculateTotalDebtBaseForAddress

    calculateTotalDebtBaseForAddress(
        address: string,
        network: Network | string
    ) {
        const networkInfo = this.getAaveNetworkInfo(network);
        const reserves = _.values(networkInfo.reserves);
        const userReserves = networkInfo.usersReserves[address];
        if (!userReserves || userReserves.length == 0) return 0;

        let debts = _.map(reserves, (reserve) => {
            const userReserve = _.find(userReserves, (o) => {
                return o.tokenaddress == reserve.address;
            });
            if (!userReserve) return null;
            return {
                price: reserve.price,
                address: reserve.address,
                balance:
                    userReserve.currentVariableDebt +
                    userReserve.currentStableDebt,
                decimals: reserve.decimals,
            };
        });

        debts = _.reject(debts, (o: any) => !o || o.balance == 0);
        if (!debts || debts.length == 0) return 0;
        return debts.reduce((total: any, debt: any) => {
            const { price, address, balance, decimals } = debt;
            const baseAmount = (balance * price) / 10 ** decimals;
            return total + baseAmount;
        }, 0);
    }

    //#endregion calculateTotalDebtBaseForAddress

    //#region calculateTotalCollateralBaseForAddress

    calculateTotalCollateralBaseForAddress(
        address: string,
        network: Network | string
    ) {
        const networkInfo = this.getAaveNetworkInfo(network);
        const reserves = _.values(networkInfo.reserves);
        const userReserves = networkInfo.usersReserves[address];
        if (!userReserves || userReserves.length == 0) return 0;

        let collaterals = _.map(reserves, (reserve) => {
            const userReserve = _.find(userReserves, (o) => {
                return o.tokenAddress == reserve.address;
            });
            if (!userReserve) return null;
            return {
                price: reserve.price,
                address: reserve.address,
                balance: userReserve.currentATokenBalance,
                usageAsCollateralEnabled: userReserve.usageAsCollateralEnabled,
                decimals: reserve.decimals,
            };
        });

        collaterals = _.reject(
            collaterals,
            (o: any) => !o || !o.usageAsCollateralEnabled || o.balance == 0
        );
        if (!collaterals || collaterals.length == 0) return 0;
        const externalCollateral =
            networkInfo.addressesObjects[address].externalCollateral ?? 0;
        return (
            externalCollateral +
            collaterals.reduce((total: any, debt: any) => {
                const { price, address, balance, decimals } = debt;
                const baseAmount = (balance * price) / 10 ** decimals;
                return total + baseAmount;
            }, 0)
        );
    }

    //#endregion calculateTotalCollateralBaseForAddress

    //#region triggerWebServerAction

    async triggerWebServerAction(type: string, network: string) {
        await this.initializeWebServerUrl();
        if (
            this.triggerWebServerActionDevDisabled &&
            process.env.LIQUIDATIONENVIRONMENT != "prod"
        ) {
            console.log(
                `Skipped triggering web server action ${type} for network ${network}`
            );
            return;
        }
        await axios.get(
            `${this.webappUrl}/refresh?type=${type}&network=${network}`
        );
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
            case "updateUsersReserves":
                await this.initializeUsersReserves(network);
                break;
            default:
                res.status(400).send("Invalid type provided");
                return;
        }

        await this.checkLiquidateAddresses(network);

        res.status(200).send("OK");
    }

    //#endregion refresh

    //#region calculateHealthFactorOffChain

    calculateHealthFactorOffChain(
        totalCollateralBase: number | Big,
        totalDebtBase: number | Big,
        currentLiquidationThreshold: number | Big
    ) {
        if (totalDebtBase == 0) return 0;
        const totalCollateralBaseBig = new Big(totalCollateralBase);
        const totalDebtBaseBig = new Big(totalDebtBase);
        const currentLiquidationThresholdBig = new Big(
            currentLiquidationThreshold
        ).div(10 ** 4);
        const healthFactor = totalCollateralBaseBig
            .times(currentLiquidationThresholdBig)
            .div(totalDebtBaseBig)
            .toNumber();
        return healthFactor;
    }

    //#endregion calculateHealthFactorOffChain

    //#region getUserAccountDataForAddresses

    async getUserAccountDataForAddresses(
        _addresses: string[],
        network: Network
    ) {
        if (!_addresses || _addresses.length == 0) return [];
        const networkInfo = await this.getAaveNetworkInfo(network);

        const userAccountData = await this.multicall(
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
            const healthFactor = this.getHealthFactorFromUserAccountData(
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

    //#region multicallEstimateGas

    async multicallEstimateGas(
        targetAddresses: string | string[],
        paramAddresses: string | string[] | null,
        contractABIsKeys: string | string[],
        methodNames: string | string[],
        network: Network
    ) {
        const estimate = await this.multicall(
            targetAddresses,
            paramAddresses,
            contractABIsKeys,
            methodNames,
            network,
            true
        );
        return Number(estimate);
    }

    //#endregion multicallEstimateGas

    //#region checkMulticallInputs

    checkMulticallInputs(
        targetAddresses: string | string[],
        params: string | string[] | null,
        contractABIsKeys: string | string[],
        methodNames: string | string[],
        network: Network
    ): [string[], string[], string[], string[]] {
        if (!network) throw new Error("No network provided");
        if (!params) params = [];

        if (!targetAddresses || targetAddresses.length == 0)
            throw new Error("No targetAddresses provided");

        if (!Array.isArray(targetAddresses))
            targetAddresses = [targetAddresses];

        if (!Array.isArray(methodNames)) methodNames = [methodNames];

        if (targetAddresses.length == 1 && params.length > 1) {
            for (let i = 1; i < params.length; i++) {
                targetAddresses.push(targetAddresses[0]);
            }
        } else if (targetAddresses.length == 1 && methodNames.length > 1) {
            for (let i = 1; i < methodNames.length; i++) {
                targetAddresses.push(targetAddresses[0]);
            }
        }

        if (!Array.isArray(params)) params = [params];

        if (
            params.length == 1 &&
            targetAddresses &&
            targetAddresses.length > 1
        ) {
            for (let i = 1; i < targetAddresses.length; i++) {
                params.push(params[0]);
            }
        }

        if (params.length > 0 && targetAddresses.length != params.length) {
            throw new Error("targetAddresses and params length mismatch");
        }

        if (!methodNames || methodNames.length == 0)
            throw new Error("No methodNames provided");

        if (
            methodNames.length == 1 &&
            targetAddresses &&
            targetAddresses.length > 1
        ) {
            for (let i = 1; i < targetAddresses.length; i++) {
                methodNames.push(methodNames[0]);
            }
        }

        if (targetAddresses.length != methodNames.length) {
            throw new Error("targetAddresses and methodNames length mismatch");
        }

        if (!contractABIsKeys || contractABIsKeys.length == 0)
            throw new Error("No contractABIs provided");

        if (!Array.isArray(contractABIsKeys))
            contractABIsKeys = [contractABIsKeys];

        if (
            contractABIsKeys.length == 1 &&
            targetAddresses &&
            targetAddresses.length > 1
        ) {
            for (let i = 1; i < targetAddresses.length; i++) {
                contractABIsKeys.push(contractABIsKeys[0]);
            }
        }

        if (targetAddresses.length != contractABIsKeys.length) {
            throw new Error("targetAddresses and contractABIs length mismatch");
        }

        return [targetAddresses, params, contractABIsKeys, methodNames];
    }

    //#endregion checkMulticallInputs

    //#region getContractInterface

    getContractInterface(contractABI: any) {
        if (!contractABI) throw new Error("No contractABI provided");
        const contractABIString = JSON.stringify(contractABI);

        if (!this.contractInterfaces[contractABIString]) {
            this.contractInterfaces[contractABIString] = new ethers.Interface(
                contractABI
            );
        }
        return this.contractInterfaces[contractABIString];
    }

    //#endregion getContractInterface

    //#region multicall

    /**
     * Batches multiple calls to a smartContract using the Multicall3 contract.
     *
     * @param targetAddresses the smartContract addresses(es) to call the method on
     * @param paramAddresses the method parameters for each smartContract address
     * @param contractABI the smartContract ABI of the function to be called
     * @param methodName the method name to be called
     * @param network the blockchain network from the AlchemySDK e.g. Network.ETH_MAINNET
     * @returns
     */
    async multicall(
        targetAddresses: string | string[],
        params: any | null,
        contractABIsKeys: string | string[],
        methodNames: string | string[],
        network: Network,
        estimateGas: boolean = false
    ) {
        [targetAddresses, params, contractABIsKeys, methodNames] =
            this.checkMulticallInputs(
                targetAddresses,
                params,
                contractABIsKeys,
                methodNames,
                network
            );

        const multicallContract = this.getContract(
            Constants.MULTICALL3_ADDRESS,
            Constants.ABIS.MULTICALL3_ABI,
            network
        );

        const calls = _.map(
            targetAddresses,
            (targetAddress: string, index: number) => {
                const contractInterface = this.getContractInterface(
                    Constants.ABIS[contractABIsKeys[index]]
                );
                const calldata =
                    !params || params.length == 0
                        ? contractInterface.encodeFunctionData(
                              methodNames[index]
                          )
                        : contractInterface.encodeFunctionData(
                              methodNames[index],
                              Array.isArray(params[index])
                                  ? params[index]
                                  : [params[index]]
                          );
                return {
                    target: targetAddress,
                    callData: calldata,
                };
            }
        );

        if (estimateGas) {
            const aaveNetworkInfo = this.getAaveNetworkInfo(network);
            return await aaveNetworkInfo.alchemyProvider.estimateGas(calls);
        }

        // Split into chunks of 1000 or fewer calls
        const callBatches = _.chunk(calls, Constants.CHUNK_SIZE);

        // Create a tracking array to map chunk results back to original indices
        const callIndices = Array.from({ length: calls.length }, (_, i) => i);
        const indexBatches = _.chunk(callIndices, Constants.CHUNK_SIZE);

        // Execute each chunk
        const chunkPromises = callBatches.map(async (callBatch) => {
            return multicallContract.aggregate(callBatch);
        });

        const chunkResults = await Promise.all(chunkPromises);

        // Process results from each chunk
        const allDecodedResults = [];

        for (
            let chunkIndex = 0;
            chunkIndex < chunkResults.length;
            chunkIndex++
        ) {
            const [blockNumber, chunkReturnData] = chunkResults[chunkIndex];
            const originalIndices = indexBatches[chunkIndex];

            // Decode each result in this chunk
            for (let i = 0; i < chunkReturnData.length; i++) {
                const originalIndex = originalIndices[i];
                const contractInterface = this.getContractInterface(
                    Constants.ABIS[contractABIsKeys[originalIndex]]
                );

                const decodedResult = contractInterface.decodeFunctionResult(
                    methodNames[originalIndex],
                    chunkReturnData[i]
                );

                // Store at the original position to maintain order
                allDecodedResults[originalIndex] = decodedResult;
            }
        }

        return allDecodedResults;
    }

    //#endregion multicall

    //#region getAaveNetworkInfo

    getAaveNetworkInfo(network: Network | string) {
        if (!network) throw new Error("No network provided");
        const key = network.toString();
        let obj = this.aave[key];
        if (!obj)
            throw new Error(`Aave network info not found for network ${key}`);
        return obj;
    }

    //#endregion getAaveNetworkInfo

    //#region getHealthFactorFromUserAccountData

    getHealthFactorFromUserAccountData(userAccountData: any) {
        const healthFactorStr = formatUnits(userAccountData[5], 18);
        return parseFloat(healthFactorStr);
    }

    //#endregion getHealthFactorFromUserAccountData

    //#region getContract

    getContract(address: string, contractAbi: any, network: Network) {
        const networkInfo = this.getAaveNetworkInfo(network);
        return new ethers.Contract(
            address,
            contractAbi,
            networkInfo.alchemyProvider
        );
    }

    //#endregion getContract

    //#region checkLiquidateAddresses

    async checkLiquidateAddresses(
        network: Network | string,
        addresses: string | string[] | null = null
    ) {
        if (!addresses) {
            addresses = _.map(
                this.aave[network].addressesObjects,
                (o) => o.address
            );
        } else if (!Array.isArray(addresses)) addresses = [addresses];
        const key = network.toString();
        let userAddressesObjects: any[] = [];
        let usersReserves: any[] = [];
        for (const address of addresses) {
            const userAddressesObject =
                this.aave[key].addressesObjects[address];
            const userReserves = this.aave[key].usersReserves[address];
            if (!userReserves || userReserves.length == 0) continue;
            userAddressesObjects.push(userAddressesObject);
            usersReserves.push(...userReserves);
        }

        await this.checkLiquidateAddressesFromInMemoryObjects(
            network,
            userAddressesObjects,
            usersReserves
        );
    }

    //#endregion checkLiquidateAddresses

    //#region checkLiquidateAddressesFromInMemoryObjects

    async checkLiquidateAddressesFromInMemoryObjects(
        network: Network | string = "eth-mainnet",
        userAddressesObjects: any[],
        usersReserves: any[] | null = null
    ) {
        const aaveNetworkInfo = this.getAaveNetworkInfo(network);
        let userAddressesObjectsAddresses = _.map(
            userAddressesObjects,
            (o) => o.address
        );
        let liquidatableAddresses: any[] = [];
        const key = network.toString();

        if (!usersReserves) {
            usersReserves = _.map(this.aave[key].usersReserves, (o) =>
                _.includes(userAddressesObjectsAddresses, o.address)
            );
        }

        if (userAddressesObjects.length > 0) {
            for (const userAddressObject of userAddressesObjects) {
                this.aave[key].addressesObjects[
                    userAddressObject.address
                ].totalCollateralBase =
                    this.calculateTotalCollateralBaseForAddress(
                        userAddressObject.address,
                        network
                    );
                this.aave[key].addressesObjects[
                    userAddressObject.address
                ].totalDebtBase = this.calculateTotalDebtBaseForAddress(
                    userAddressObject.address,
                    network
                );
                this.aave[key].addressesObjects[
                    userAddressObject.address
                ].healthFactor = this.calculateHealthFactorOffChain(
                    this.aave[key].addressesObjects[userAddressObject.address]
                        .totalCollateralBase,
                    this.aave[key].addressesObjects[userAddressObject.address]
                        .totalDebtBase,
                    userAddressObject.currentLiquidationThreshold
                );
                if (
                    this.aave[key].addressesObjects[userAddressObject.address]
                        .healthFactor < 1
                ) {
                    liquidatableAddresses.push(userAddressObject.address);
                }
            }

            if (liquidatableAddresses.length > 0) {
                const liquidatableUserAddressObjects = _.filter(
                    userAddressesObjects,
                    (o) => _.includes(liquidatableAddresses, o.address)
                );

                let profitableLiquidations: any[] = [];
                for (const liquidatableUserAddressObject of liquidatableUserAddressObjects) {
                    const userReserves =
                        this.aave[key].usersReserves[
                            liquidatableUserAddressObject.address
                        ];
                    if (!userReserves || userReserves.length == 0) continue;

                    let potentialProfitableLiquidation: any = {
                        profit: 0,
                    };
                    for (const userReserve of userReserves) {
                        if (
                            userReserve.usageAsCollateralEnabled &&
                            this.isReserveUsedAsCollateral(
                                liquidatableUserAddressObject.userConfiguration,
                                userReserve.tokenaddress,
                                network
                            ) &&
                            userReserve.currentATokenBalance > 0
                        ) {
                            for (const debtUserReserve of userReserves) {
                                if (
                                    userReserve.tokenaddress !=
                                        debtUserReserve.tokenaddress &&
                                    (debtUserReserve.currentStableDebt > 0 ||
                                        debtUserReserve.variabledebt > 0)
                                ) {
                                    //we are in a collateral / debt pair whose balance is both > 0.
                                    //calculate potential profit of liquidation for this asset pair
                                    const [debtToCover, profitInUSD] =
                                        this.calculateNetLiquidationReward(
                                            userReserve,
                                            debtUserReserve,
                                            liquidatableUserAddressObject.healthFactor,
                                            network
                                        );

                                    const profitInUSDNumber =
                                        profitInUSD.toNumber();
                                    if (
                                        profitInUSDNumber >
                                        potentialProfitableLiquidation.profit
                                    ) {
                                        potentialProfitableLiquidation = {
                                            profit: profitInUSDNumber,
                                            collateralAsset:
                                                userReserve.tokenaddress,
                                            debtAsset:
                                                debtUserReserve.tokenaddress,
                                            address:
                                                liquidatableUserAddressObject.address,
                                            debtToCover: debtToCover,
                                        };
                                    }
                                }
                            }
                        }
                    }

                    if (potentialProfitableLiquidation.profit > 0)
                        profitableLiquidations.push(
                            potentialProfitableLiquidation
                        );
                }

                if (profitableLiquidations.length > 0) {
                    const liquidationsEnabled = false;
                    if (liquidationsEnabled) {
                        const liquidationsParameters = _.map(
                            profitableLiquidations,
                            (o) => {
                                return [
                                    o.collateralAsset,
                                    o.debtAsset,
                                    o.address,
                                    o.debtToCover,
                                    true, //receive aTokens
                                ];
                            }
                        );
                        await this.multicall(
                            aaveNetworkInfo.aaveAddresses.pool,
                            liquidationsParameters,
                            "POOL_ABI",
                            "liquidationCall",
                            aaveNetworkInfo.network
                        );
                    } else {
                        /*
                        await emailManager.sendLogEmail(
                            "Liquidation triggered",
                            "Data: " + JSON.stringify(profitableLiquidations)
                        );
                        */
                        await logger.log(
                            JSON.stringify(profitableLiquidations),
                            "liquidationTriggered",
                            LogType.Trace,
                            LoggingFramework.Table
                        );
                    }
                }
            }
        }
    }

    //#endregion checkLiquidateAddressesFromInMemoryObjects

    //#region calculateNetLiquidationReward

    calculateNetLiquidationReward(
        collateralAssetObject: any,
        debtAssetObject: any,
        healthFactor: number,
        network: Network | string
    ) {
        const aaveNetworkInfo = this.getAaveNetworkInfo(network);
        const debtAmountTotal: Big = new Big(
            debtAssetObject.currentStableDebt ?? 0
        ).add(new Big(debtAssetObject.currentVariableDebt ?? 0));
        const closeFactor = healthFactor > 0.95 ? 0.5 : 1; // 50% close factor if health factor is > 0.95, otherwise 100%
        const liquidatableDebtAmount: Big = debtAmountTotal
            .mul(closeFactor)
            .div(10000);

        const debtTokenAddress = debtAssetObject.tokenaddress;
        const collateralTokenAddress = collateralAssetObject.tokenaddress;
        const debtTokenReserve = aaveNetworkInfo.reserves[debtTokenAddress];
        const collateralTokenReserve =
            aaveNetworkInfo.reserves[collateralTokenAddress];
        const debtDecimals = debtTokenReserve.decimals;
        const collateralDecimals = collateralTokenReserve.decimals;
        const liquidationProtocolFee =
            collateralTokenReserve.liquidationProtocolFee;
        const liquidationBonus = collateralTokenReserve.liquidationBonus;
        const debtPrice = new Big(debtTokenReserve.price);
        const collateralPrice = new Big(collateralTokenReserve.price);

        // 1. Calculate the base collateral amount (without bonus)
        const baseCollateral = liquidatableDebtAmount
            .mul(debtPrice)
            .mul(10 ** collateralDecimals)
            .div(collateralPrice.mul(10 ** debtDecimals));

        // 2. Calculate the bonus amount
        const bonusAmount = baseCollateral
            .mul(liquidationBonus - 10000) // Subtract 100% to get just the bonus portion
            .div(10000);

        // 3. Calculate the protocol fee (applied only to the bonus portion)
        const protocolFeeAmount = bonusAmount
            .mul(liquidationProtocolFee)
            .div(10000);

        // 4. Calculate the total collateral received after protocol fee (in native units)
        const totalCollateralReceived = baseCollateral
            .add(bonusAmount)
            .sub(protocolFeeAmount);

        // 5. Convert collateral value to USD
        const collateralValueUSD = totalCollateralReceived
            .mul(collateralPrice)
            .div(10 ** collateralDecimals);

        // 6. Convert debt to USD for profit calculation
        const debtValueUSD = liquidatableDebtAmount
            .mul(debtPrice)
            .div(10 ** debtDecimals);

        // 6. Calculate gross profit in USD
        const grossProfitUSD = collateralValueUSD.sub(debtValueUSD);

        // 7. Calculate gas cost in USD with the appropriate multiplier
        // Initial calculation with base fee
        const wethReserve = _.find(_.values(aaveNetworkInfo.reserves), {
            symbol: "WETH",
        });
        const ethPriceUSD = new Big(wethReserve.price).div(
            10 ** wethReserve.decimals
        );
        const baseTxCostWei = new Big(
            aaveNetworkInfo.averageLiquidationGasUnits
        ).mul(aaveNetworkInfo.gasPrice);
        const baseTxCostUSD = baseTxCostWei
            .mul(ethPriceUSD)
            .div(10 ** wethReserve.decimals);

        // Apply fee tier based on gross profit
        const gasFeeMultiplier = grossProfitUSD.gt(new Big(100)) ? 10000 : 5000;
        const scaledGasMultiplier = new Big(gasFeeMultiplier).div(10000);
        const actualTxCostUSD = baseTxCostUSD.mul(scaledGasMultiplier);

        // 8. Calculate net profit in USD
        const netProfitUSD = grossProfitUSD.sub(actualTxCostUSD);

        // Return: [debtToCover in native units, profit in USD]
        return [
            liquidatableDebtAmount, // Amount of debt tokens to repay (native units)
            netProfitUSD, // Profit in USD
        ];
    }

    //#endregion calculateNetLiquidationReward

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

            const results = await this.multicall(
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

            const reserveTokenAddresses = await this.multicall(
                aaveNetworkInfo.aaveAddresses.poolDataProvider,
                _.map(allReserveTokens, (o) => o.address),
                "POOL_DATA_PROVIDER_ABI",
                "getReserveTokensAddresses",
                aaveNetworkInfo.network
            );

            //const reserveTokenAddresses = results[1][0];
            for (let i = 0; i < reserveTokenAddresses.length; i++) {
                allReserveTokens[i].aTokenAddress =
                    reserveTokenAddresses[i][0].toString();
                allReserveTokens[i].stableDebtTokenAddress =
                    reserveTokenAddresses[i][1].toString();
                allReserveTokens[i].variableDebtTokenAddress =
                    reserveTokenAddresses[i][2].toString();
            }

            const allReserveTokensAddresses = _.map(
                allReserveTokens,
                (o) => o.address
            );

            const reservesData1 = await this.multicall(
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

            const reservesConfigData1 = await this.multicall(
                aaveNetworkInfo.aaveAddresses.poolDataProvider,
                allReserveTokensAddresses,
                "POOL_DATA_PROVIDER_ABI",
                "getReserveConfigurationData",
                aaveNetworkInfo.network
            );

            //update reserves liquidationProtocolFee
            const liquidationProtocolFees = await this.multicall(
                aaveNetworkInfo.aaveAddresses.poolDataProvider,
                allReserveTokensAddresses,
                "POOL_DATA_PROVIDER_ABI",
                "getLiquidationProtocolFee",
                aaveNetworkInfo.network
            );

            for (let i = 0; i < reservesConfigData1.length; i++) {
                allReserveTokens[i].decimals = reservesConfigData1[i][0];
                allReserveTokens[i].ltv = reservesConfigData1[i][1].toString();
                allReserveTokens[i].reserveliquidationthreshold =
                    reservesConfigData1[i][2].toString();
                allReserveTokens[i].reserveLiquidationBonus =
                    reservesConfigData1[i][3].toString();
                allReserveTokens[i].reserveFactor =
                    reservesConfigData1[i][4].toString();
                allReserveTokens[i].usageAsCollateralEnabled =
                    sqlManager.getBitFromBoolean(reservesConfigData1[i][5]);
                allReserveTokens[i].borrowingEnabled =
                    sqlManager.getBitFromBoolean(reservesConfigData1[i][6]);
                allReserveTokens[i].stableBorrowRateEnabled =
                    sqlManager.getBitFromBoolean(reservesConfigData1[i][7]);
                allReserveTokens[i].isActive = sqlManager.getBitFromBoolean(
                    reservesConfigData1[i][8]
                );
                allReserveTokens[i].isFrozen = sqlManager.getBitFromBoolean(
                    reservesConfigData1[i][9]
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

            //delete reserves and usersreserves data where token address is not in the reserves list
            const sqlQueryDelete = `DELETE FROM usersreserves WHERE tokenaddress NOT IN ('${fetchedReservesAddresses.join(
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
                    }', '${o.aTokenAddress}','${
                        o.variableDebtTokenAddress
                    }', '${o.stableDebtTokenAddress}', '${
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
                    ) AS source (address, network, symbol, decimals, reserveLiquidationThreshold, reserveLiquidationBonus, reserveFactor, usageAsCollateralEnabled, borrowingEnabled, stableBorrowRateEnabled, isActive, isFrozen, liquidationProtocolFee, liquidityIndex, variableBorrowIndex, liquidityRate, variableBorrowRate, lastUpdateTimestamp, aTokenAddress, variableDebtTokenAddress, stableDebtTokenAddress, totalStableDebt, totalVariableDebt, ltv, sorting, modifiedOn)
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
                        aTokenAddress = source.aTokenAddress,
                        variableDebtTokenAddress = source.variableDebtTokenAddress,
                        stableDebtTokenAddress = source.stableDebtTokenAddress,
                        totalStableDebt = source.totalStableDebt,
                        totalVariableDebt = source.totalVariableDebt,
                        ltv = source.ltv,
                        sorting = source.sorting,
                        modifiedOn = source.modifiedOn
                    WHEN NOT MATCHED BY TARGET THEN
                        INSERT (address, network, symbol, decimals, reserveLiquidationThreshold, reserveLiquidationBonus, reserveFactor, usageAsCollateralEnabled, borrowingEnabled, stableBorrowRateEnabled, isActive, isFrozen, liquidationProtocolFee, liquidityIndex, variableBorrowIndex, liquidityRate, variableBorrowRate, lastUpdateTimestamp, aTokenAddress, variableDebtTokenAddress, stableDebtTokenAddress, totalStableDebt, totalVariableDebt, ltv, sorting, modifiedOn)
                        VALUES (source.address, source.network, source.symbol, source.decimals, source.reserveLiquidationThreshold, source.reserveLiquidationBonus, source.reserveFactor, source.usageAsCollateralEnabled, source.borrowingEnabled, source.stableBorrowRateEnabled, source.isActive, source.isFrozen, source.liquidationProtocolFee, source.liquidityIndex, source.variableBorrowIndex, source.liquidityRate, source.variableBorrowRate, source.lastUpdateTimestamp, source.aTokenAddress, source.variableDebtTokenAddress, source.stableDebtTokenAddress, source.totalStableDebt, source.totalVariableDebt, source.ltv, source.sorting, source.modifiedOn);
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

                await this.updateUsersReservesData(
                    addressesUserAccountDataHFLowerThan2,
                    aaveNetworkInfo
                );

                //Save data to the DB:
                //NOTE: it is not necessary to save the totalDebtBase to the DB, since
                //it will be calculated anyway from the usersreserves data.
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
                    DELETE FROM usersreserves WHERE address IN ('${chunks[
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

    //#region updateTokensPrices

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
    async updateTokensPrices(
        context: InvocationContext | null = null,
        network: Network | null = null //if network is not defined, loop through all networks
    ) {
        logger.initialize(
            "function:updateTokensPrices",
            LoggingFramework.ApplicationInsights,
            context
        );
        await logger.log("Start updateTokensPrices");

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
                aaveNetworkInfo.reserves,
                "address",
                "price"
            );

            //get current reserves prices from the network
            const aaveOracleContract = this.getContract(
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
            let shouldPerformCheck = false;
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

                    //if we come here, it means there is at least 1 changed reserve. We should perform the check
                    //later on all accounts that have the changed reserves either as collateral or as debt
                    //depending if price has gone up or down
                    shouldPerformCheck = true;

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
                        "initializeReserves",
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

    //#endregion updateTokensPrices

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
            DELETE FROM dbo.changes WHERE timestamp < DATEADD(DAY, -2, GETUTCDATE());
        `;
        await sqlManager.execQuery(query);
        await logger.log("Ended function deleteOldTablesEntries");
    }

    //#endregion Function: deleteOldTablesEntries

    //#endregion Scheduled azure functions

    //#region #ProcessAaveEvent (Alchemy Webhook)

    async processAaveEvent(req: any, res: any) {
        if (!this.isWebServerInitialized) return;
        let block = req.body.event?.data?.block;
        let network = req.query.network ?? "eth-mainnet";
        await this.processBlock(block, network);
    }

    async processBlock(block: any, network: string) {
        const key = network;
        for (let log of block.logs) {
            let topics = log.topics;
            let eventHash = topics[0];
            let addressesToAdd: string[] = [];
            let from = log.transaction?.from?.address;
            const addressesObjectsAddresses = _.map(
                this.aave[key].addressesObjects,
                (o) => o.address
            );

            switch (eventHash) {
                case "0x9c369e2bdbd7c7a5b5c8c0b9e6f5f4b1a8dc9b3f2e5c123c3a9e3b4d3e0c4a9f": //SwapBorrowRateMode
                    addressesToAdd.push(log.topics[2]);
                    break;

                case "0x121ca0f2b1a8b5c8c0b9e6f5f4b1a8dc9b3f2e5c123c3a9e3b4d3e0c4a9f8f9": //UserEModeSet
                    addressesToAdd.push(log.topics[1]);
                    break;

                case "0xd3d8717c9c7a8b5c8c0b9e6f5f4b1a8dc9b3f2e5c123c3a9e3b4d3e0c4a9f8f9": //BackUnbacked
                    addressesToAdd.push(log.topics[2]);
                    break;

                case "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9": //MintUnbacked
                    addressesToAdd.push(log.topics[3]); //onBehalfOf The address of the user
                    break;

                case "0xe6cd5d3f2cfd1bf39c09a4afc6cfbfbce2a3c2c5c9d64e7464b3a8b5c2eecb1e": //FlashLoan
                    const flashloanTarget = log.topics[1];
                    if (flashloanTarget) addressesToAdd.push(flashloanTarget);
                    const flashloanInitiator = log.topics[2];
                    if (flashloanInitiator)
                        addressesToAdd.push(flashloanInitiator);
                    break;

                case "0x9a2f48d3aa6146e0a0f4e8622b5ff4b9d90a3c4f5e9a3b69c8523e213f775bfe": //LiquidationCall
                    const decodedLogLiquidationCall =
                        this.ifaceLiquidationCall.parseLog(log);
                    const userLiquidator =
                        decodedLogLiquidationCall.args.liquidator;
                    if (userLiquidator) addressesToAdd.push(userLiquidator);
                    const userLiquidated = log.topics[3];
                    addressesToAdd.push(userLiquidated); //liquidated user
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
                        this.aave[key].usersReserves[userLiquidated][
                            liquidationCollateralAsset
                        ].currentATokenBalance -= liquidatedCollateralAmount;

                        //detract the debt to cover from the user's debt
                        if (
                            this.aave[key].usersReserves[userLiquidated][
                                liquidationDebtAsset
                            ].currentStableDebt >= debtToCover
                        ) {
                            this.aave[key].usersReserves[userLiquidated][
                                liquidationDebtAsset
                            ].currentStableDebt -= debtToCover;
                        } else {
                            this.aave[key].usersReserves[userLiquidated][
                                liquidationDebtAsset
                            ].currentVariableDebt -= debtToCover;
                        }

                        await this.updateUserConfiguration(userLiquidated, key);
                    }

                    if (addressesObjectsAddresses.includes(userLiquidator)) {
                        if (receiveAToken) {
                            //add the liquidated collateral amount to the liquidator's collateral
                            this.aave[key].usersReserves[userLiquidator][
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
                    const decodedLogDeposit = this.ifaceDeposit.parseLog(log);
                    const userDeposit = decodedLogDeposit.args.user;
                    if (userDeposit) addressesToAdd.push(userDeposit);
                    if (log.topics.length > 3)
                        addressesToAdd.push(log.topics[3]); //onBehalfOf The beneficiary of the deposit, receiving the aTokens

                    const depositReserve = log.topics[1];
                    const depositAmount = decodedLogDeposit.args.amount;
                    const depositOnBehalfOf = log.topics[3];
                    if (
                        addressesObjectsAddresses.includes(depositOnBehalfOf) &&
                        this.isReserveUsedAsCollateral(
                            this.aave[key].addressesObjects[depositOnBehalfOf]
                                .userConfiguration,
                            depositReserve,
                            key
                        )
                    ) {
                        this.aave[key].usersReserves[depositOnBehalfOf][
                            depositReserve
                        ].currentATokenBalance += depositAmount;
                    }
                    break;

                //Borrow
                case "0xc6a898309e823ee50bac64e45ca8adba6690e99e7841c45d754e2a38e9019d9b":
                    const decodedLogBorrow = this.ifaceBorrow.parseLog(log);
                    const borrowOnBehalfOf = log.topics[3];
                    const borrowReserve = log.topics[1];
                    const borrowedAmount = decodedLogBorrow.args.amount;
                    const borrowRateMode = decodedLogBorrow.args.borrowRateMode;

                    const userBorrow = decodedLogBorrow.args.user;
                    if (userBorrow) addressesToAdd.push(userBorrow);
                    if (borrowOnBehalfOf && borrowOnBehalfOf != userBorrow) {
                        addressesToAdd.push(borrowOnBehalfOf); //onBehalfOf The beneficiary of the borrow, receiving the aTokens
                    }

                    if (addressesObjectsAddresses.includes(borrowOnBehalfOf)) {
                        if (borrowRateMode == 1) {
                            this.aave[key].usersReserves[borrowOnBehalfOf][
                                borrowReserve
                            ].currentStableDebt += borrowedAmount;
                        } else {
                            this.aave[key].usersReserves[borrowOnBehalfOf][
                                borrowReserve
                            ].currentVariableDebt += borrowedAmount;
                        }

                        await this.checkLiquidateAddresses(
                            borrowOnBehalfOf,
                            key
                        );
                    }

                    break;

                case "0xa534c8dbe71f871f9f3530e97a74601fea17b426cae02e1c5aee42c96c784051": //Repay
                    if (log.topics.length > 2)
                        addressesToAdd.push(log.topics[2]); //user The beneficiary of the repayment, getting his debt reduced
                    if (log.topics.length > 3)
                        addressesToAdd.push(log.topics[3]); //repayer The address of the user initiating the repay(), providing the funds

                    const repayReserve = log.topics[1];
                    const decodedLogRepay = this.ifaceRepay.parseLog(log);
                    const amountRepayed = decodedLogRepay.args.amount;
                    const useATokens = decodedLogRepay.args.useATokens;

                    //detract the amount repaid from the repayer's collateral
                    if (
                        addressesObjectsAddresses.includes(log.topics[3]) &&
                        useATokens
                    ) {
                        this.aave[key].usersReserves[log.topics[3]][
                            repayReserve
                        ].currentATokenBalance -= amountRepayed;
                    }

                    //detract the repaid amount from the beneficiary's debt
                    if (addressesObjectsAddresses.includes(log.topics[2])) {
                        const address = log.topics[2];
                        const repayUserReserve =
                            this.aave[key].usersReserves[address][repayReserve];

                        //I cannot know if the debt being repaid is stable or variable, since this info
                        //is not present in the Repay event. So I check the amount of the variable debt and
                        //evtl then even the stable debt, since in the end I am interested in the total debt
                        if (
                            repayUserReserve.currentStableDebt == 0 ||
                            repayUserReserve.currentVariableDebt >=
                                amountRepayed
                        ) {
                            this.aave[key].usersReserves[address][
                                repayReserve
                            ].currentVariableDebt -= amountRepayed;
                        } else {
                            this.aave[key].usersReserves[address][
                                repayReserve
                            ].currentStableDebt -= amountRepayed;
                        }

                        await this.checkLiquidateAddresses(address, key);
                        await this.updateUserConfiguration(address, key);
                    }
                    break;

                case "0x2b627736bca15cd5381dcf80b0bf11fd197d01a037c52b927a881a10fb73ba61": //Supply
                    if (log.topics.length > 2)
                        addressesToAdd.push(log.topics[2]); //user The address of the user

                    const decodedLogSupply = this.ifaceSupply.parseLog(log);
                    const amount = decodedLogSupply.args.amount;
                    const onBehalfOf = log.topics[3];
                    const topicAddress = log.topics[2];
                    let address = topicAddress; //the actual beneficiary of the supply
                    if (onBehalfOf && onBehalfOf != topicAddress) {
                        address = onBehalfOf; //the actual beneficiary of the supply
                        addressesToAdd.push(onBehalfOf);
                    }
                    if (_.includes(addressesObjectsAddresses, address)) {
                        const reserve = log.topics[1];
                        const userConfiguration =
                            this.aave[key].addressesObjects[address]
                                .userConfiguration;
                        if (
                            this.isReserveUsedAsCollateral(
                                userConfiguration,
                                reserve,
                                key
                            )
                        ) {
                            this.aave[key].usersReserves[address][
                                reserve
                            ].currentATokenBalance += amount;

                            if (
                                this.aave[key].usersReserves[address][reserve]
                                    .usageAsCollateralEnabled
                            ) {
                                await this.checkLiquidateAddresses(
                                    address,
                                    key
                                );
                                await this.updateUserConfiguration(
                                    address,
                                    key
                                );
                            }
                        }
                    }

                    break;

                case "0x44c58d81365b66dd4b1a7f36c25aa97b8c71c361ee4937adc1a00000227db5dd": //ReserveUsedAsCollateralDisabled
                    if (log.topics.length > 2)
                        addressesToAdd.push(log.topics[2]); //user The address of the user

                    if (_.includes(addressesObjectsAddresses, log.topics[2])) {
                        const address = log.topics[2];
                        const reserve = log.topics[1];
                        this.aave[key].usersReserves[address][
                            reserve
                        ].usageAsCollateralEnabled = false;

                        await this.checkLiquidateAddresses(network, address);

                        const query = `UPDATE usersreserves SET usageAsCollateralEnabled = 0 WHERE address = '${address}' AND tokenaddress = '${reserve}' AND network = '${key}'`;
                        await sqlManager.execQuery(query);

                        await this.updateUserConfiguration(address, key);
                    }

                    break;

                case "0x00058a56ea94653cdf4f152d227ace22d4c00ad99e2a43f58cb7d9e3feb295f2": //ReserveUsedAsCollateralEnabled
                    if (log.topics.length > 2)
                        addressesToAdd.push(log.topics[2]); //user The address of the user

                    if (_.includes(addressesObjectsAddresses, log.topics[2])) {
                        const address = log.topics[2];
                        const reserve = log.topics[1];
                        this.aave[key].usersReserves[address][
                            reserve
                        ].usageAsCollateralEnabled = true;

                        await this.checkLiquidateAddresses(network, address);

                        const query = `UPDATE usersreserves SET usageAsCollateralEnabled = 1 WHERE address = '${address}' AND tokenaddress = '${reserve}' AND network = '${key}'`;
                        await sqlManager.execQuery(query);

                        await this.updateUserConfiguration(address, key);
                    }

                    break;

                case "0x9f439ae0c81e41a04d3fdfe07aed54e6a179fb0db15be7702eb66fa8ef6f5300": //RebalanceStableBorrowRate
                    if (log.topics.length > 2)
                        addressesToAdd.push(log.topics[2]); //user The address of the user
                    break;

                case "0xea368a40e9570069bb8e6511d668293ad2e1f03b0d982431fd223de9f3b70ca6": //Swap
                    if (log.topics.length > 2)
                        addressesToAdd.push(log.topics[2]); //user The address of the user
                    break;

                case "0x3115d1449a7b732c986cba18244e897a450f61e1bb8d589cd2e69e6c8924f9f7": //Withdraw
                    if (log.topics.length > 2)
                        addressesToAdd.push(log.topics[2]); //user The address initiating the withdrawal, owner of aTokens
                    if (log.topics.length > 3)
                        addressesToAdd.push(log.topics[3]); //to Address that will receive the underlying

                    const decodedLogWithdraw = this.ifaceWithdraw.parseLog(log);
                    const amountWithdrawn = decodedLogWithdraw.args.amount;
                    if (_.includes(addressesObjectsAddresses, log.topics[2])) {
                        const reserve = log.topics[1];
                        const userConfiguration =
                            this.aave[key].addressesObjects[log.topics[2]]
                                .userConfiguration;
                        if (
                            this.isReserveUsedAsCollateral(
                                userConfiguration,
                                reserve,
                                key
                            ) &&
                            this.aave[key].usersReserves[log.topics[2]][reserve]
                                .usageAsCollateralEnabled
                        ) {
                            this.aave[key].usersReserves[log.topics[2]][
                                reserve
                            ].currentATokenBalance -= amountWithdrawn;

                            await this.checkLiquidateAddresses(
                                log.topics[2],
                                key
                            );
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

            if (addressesToAdd.length > 0) {
                //the "from" address is the one that initiated the transaction
                //and should be added only if it was part of one of the relevant events
                if (from) addressesToAdd.push(from);

                //normalize addresses
                let normalizedAddressesToAdd = _.map(
                    addressesToAdd,
                    (address) => common.normalizeAddress(address)
                );

                //initialize the batchAddressesListSql array for this network
                //if it doesn't exist yet
                if (!this.aave[key].hasOwnProperty("batchAddressesListSql")) {
                    this.aave[key].batchAddressesListSql = [];
                }
                if (!this.aave[key].hasOwnProperty("batchAddressesList")) {
                    this.aave[key].batchAddressesList[key] = [];
                }

                //Remove empty addresses or addresses already present in the DB or in the
                //current batch of addresses to be saved
                const uniqueAddresses: string[] = _.reject(
                    _.uniq(normalizedAddressesToAdd),
                    (normalizedAddress) => {
                        return (
                            _.isEmpty(normalizedAddress) ||
                            _.includes(
                                this.aave[key].addresses,
                                normalizedAddress
                            ) ||
                            _.includes(
                                this.aave[key].batchAddressesList,
                                normalizedAddress
                            )
                        );
                    }
                );

                //if there are any unique addresses to add, get their health factor and user configuration
                if (uniqueAddresses.length > 0) {
                    let addressesListSql: string[] = [];
                    let addressesList: string[] = [];

                    for (const address of uniqueAddresses) {
                        addressesListSql.push(
                            `('${address}', '${key}', null, GETDATE())`
                        );
                        addressesList.push(address);
                    }

                    //if there are addresses with healthFactor < 2
                    //add them to the batchAddressesListSql array for this network
                    //to be monitored and saved in the database
                    if (addressesListSql.length > 0) {
                        if (
                            !this.aave[key].hasOwnProperty(
                                "batchAddressesListSql"
                            )
                        ) {
                            this.aave[key].batchAddressesListSql = [];
                        }
                        if (!this.aave[key].hasOwnProperty("addresses"))
                            this.aave[key].addresses = [];

                        this.aave[key].batchAddressesListSql = _.union(
                            this.aave[key].batchAddressesListSql,
                            addressesListSql
                        );
                        this.aave[key].batchAddressesList = _.union(
                            this.aave[key].batchAddressesList,
                            addressesList
                        );

                        if (
                            this.aave[key].batchAddressesListSql.length >=
                            this.batchAddressesTreshold
                        ) {
                            let query = `
                            MERGE INTO addresses AS target
                            USING (VALUES 
                                ${this.aave[key].batchAddressesList.join(",")}
                            ) AS source (address, network, healthFactor, addedOn)
                            ON (target.address = source.address AND target.network = source.network)
                            WHEN NOT MATCHED BY TARGET THEN
                                INSERT (address, network, healthFactor, addedOn)
                                VALUES (source.address, source.network, source.healthFactor, source.addedOn);
                        `;

                            await sqlManager.execQuery(query);

                            await logger.log(
                                "Addresses added to the database: " +
                                    JSON.stringify(
                                        this.aave[key].batchAddressesList
                                    ),
                                "WebserverEngineProcessBlock"
                            );

                            this.aave[key].batchAddressesListSql = [];
                            this.aave[key].batchAddressesList = [];
                            this.aave[key].addresses = _.uniq(
                                _.union(
                                    this.aave[key].addresses,
                                    uniqueAddresses
                                )
                            );
                        }
                    }
                }
            }
        }
    }

    //#endregion processAaveEvent (Alchemy Webhook)

    //#region #Testing

    async doTest() {
        console.log(Network.ARB_MAINNET.toString());
    }

    //#endregion Testing methods
}

export default Engine.getInstance();
