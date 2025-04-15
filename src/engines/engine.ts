import common from "../shared/common";
import _ from "lodash";
import encryption from "../shared/encryption";
import sqlManager from "../managers/sqlManager";
import { ethers, formatUnits } from "ethers";
import Big from "big.js";
import logger from "../shared/logger";
import { InvocationContext } from "@azure/functions";
import { LoggingFramework, UserReserveType } from "../shared/enums";
import Constants from "../shared/constants";
import { Alchemy, Network } from "alchemy-sdk";
import emailManager from "../managers/emailManager";

class Engine {
    private static instance: Engine;
    private constructor() {}

    public static getInstance(): Engine {
        if (!Engine.instance) {
            Engine.instance = new Engine();
        }
        return Engine.instance;
    }

    //#region Initialization

    async initializeUsersReserves(network: Network | null = null) {
        if (!this.aave) throw new Error("Aave object not initialized");
        const _key = network ? this.getAaveNetworkString(network) : null;
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
            const key = this.getAaveNetworkString(aaveNetworkInfo);
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
        }
    }

    async initializeReserves(network: Network | null = null) {
        if (!this.aave) throw new Error("Aave object not initialized");
        const _key = network ? this.getAaveNetworkString(network) : null;
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
            const key = this.getAaveNetworkString(aaveNetworkInfo);
            if (_key && key != _key) continue;

            const networkReserves = _.filter(dbReserves, { network: key });
            for (let networkReserve of networkReserves) {
                reserves[networkReserve.address] = networkReserve;
            }
            this.aave[key] = _.assign(aaveNetworkInfo, { reserves: reserves });
        }
    }

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
            const key = this.getAaveNetworkString(aaveNetworkInfo);

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
                aaveNetworkInfo.addresses.poolAddressesProvider,
                null,
                "ADDRESSES_PROVIDER_ABI",
                ["getPoolDataProvider", "getPriceOracle", "getPool"],
                aaveNetworkInfo.network
            );

            if (!addresses) {
                await logger.log(
                    `No addresses found for network ${this.getAaveNetworkString(
                        aaveNetworkInfo
                    )}`,
                    "functionAppExecution"
                );
                return;
            }

            networkInfo.addresses.poolDataProvider = addresses[0]?.toString();
            networkInfo.addresses.aaveOracle = addresses[1]?.toString();
            networkInfo.addresses.pool = addresses[2]?.toString();
        }
    }

    //#endregion Initialization

    //#region Variables

    aave: any;
    contractInterfaces: any = {};

    //#endregion Variables

    //#region Helper methods

    calculateTotalDebtBaseForAddress(address: string, network: Network) {
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
                    userReserve.currentvariabledebt +
                    userReserve.currentstabledebt,
                decimals: reserve.decimals,
            };
        });

        debts = _.reject(debts, (o: any) => o.balance == 0);
        if (!debts || debts.length == 0) return 0;
        return debts.reduce((total: any, debt: any) => {
            const { price, address, balance, decimals } = debt;
            const baseAmount = (balance * price) / 10 ** decimals;
            return total + baseAmount;
        }, 0);
    }

    getAaveNetworkString(aaveNetworkInfo: any) {
        return aaveNetworkInfo.hasOwnProperty("network")
            ? aaveNetworkInfo.network.toString()
            : aaveNetworkInfo.toString();
    }

    /**
     * TODO Decide which asset pair to liquidate for a given user
     *
     * @param address
     * @param assets is an object with two arrays: collateral and debt
     * @returns Array of asset pair to liquidate [collateralAsset, debtAsset]
     */
    async decideWhichAssetPairToLiquidate(address: any, assets: any) {
        //TODO how to decide which asset pair to liquidate?
        //TODO: check if the liquidation is profitable otherwise skip it

        const userCollateralAssets = assets.collateral;
        const userDebtAssets = assets.debt;

        /*
        // Iterate through each reserve and get user data
        for (const reserve of reservesList) {
            const reserveData = await this.poolContract.getReserveData(
                reserve
            );

            // Check user's balances for the collateral and debt tokens
            const aTokenContract = new ethers.Contract(
                reserveData.aTokenAddress,
                this.aaveTokenBalanceOfAbi,
                this.signer
            );
            const stableDebtTokenContract = new ethers.Contract(
                reserveData.stableDebtTokenAddress,
                this.aaveTokenBalanceOfAbi,
                this.signer
            );
            const variableDebtTokenContract = new ethers.Contract(
                reserveData.variableDebtTokenAddress,
                this.aaveTokenBalanceOfAbi,
                this.signer
            );

            const aTokenBalance = await aTokenContract.balanceOf(address);
            const stableDebtBalance = await stableDebtTokenContract.balanceOf(
                address
            );
            const variableDebtBalance =
                await variableDebtTokenContract.balanceOf(address);

            return {
                collateralAsset: "",
                debtAsset: "",
            };
        }
            */
        return ["", ""];
    }

    getHealthFactorOffChain(address: string) {
        //TODO MIRKO get health factor from DB for the address
        const healthFactor = 1.5;
        return healthFactor;
    }

    getUserAssetsFromUserConfiguration(
        userConfiguration: string,
        network: Network
    ): { debt: string[]; collateral: string[] } {
        if (!userConfiguration || !network)
            throw new Error("UserConfiguration and Network must be defined");

        let userAssets: any = {
            debt: [],
            collateral: [],
        };
        const aaveNetworkInfo = this.getAaveNetworkInfo(network);
        let i = userConfiguration.length - 1;

        //loop through reserves
        for (let reserveAddress of Object.keys(aaveNetworkInfo.reserves)) {
            if (userConfiguration[i] == "1") {
                userAssets.debt.push(reserveAddress);
            }

            if (i > 0 && userConfiguration[i - 1] == "1") {
                userAssets.collateral.push(reserveAddress);
            }

            i = i - 2;
        }

        return userAssets;
    }

    async getUserAccountDataForAddresses(
        _addresses: string[],
        network: Network
    ) {
        if (!_addresses || _addresses.length == 0) return [];

        let results: any[] = [];

        const networkInfo = await this.getAaveNetworkInfo(network);

        const userAccountData = await this.multicall(
            networkInfo.addresses.pool,
            _addresses,
            "POOL_ABI",
            "getUserAccountData",
            network
        );

        //check immediately after retrieving userAccountData if the health factor is less than 1, liquidate concerned addresses
        //immediately without waiting for the userConfiguration
        let liquidateHealthFactorAddresses: string[] = [];
        let userAccountObjects: any[] = [];
        for (let i = 0; i < _addresses.length; i++) {
            const address = _addresses[i];
            const healthFactor = this.getHealthFactorFromUserAccountData(
                userAccountData[i]
            );
            const totalCollateralBase = userAccountData[i][0].toString();
            const totalDebtBase = userAccountData[i][1].toString();
            userAccountObjects.push({
                healthFactor: healthFactor,
                totalCollateralBase: totalCollateralBase,
                totalDebtBase: totalDebtBase,
            });
            if (healthFactor < 1) {
                liquidateHealthFactorAddresses.push(address);
            }
        }

        await this.checkLiquidateAddresses(
            liquidateHealthFactorAddresses,
            network
        );

        const userConfiguration = await this.multicall(
            networkInfo.addresses.pool,
            _addresses,
            "POOL_ABI",
            "getUserConfiguration",
            network
        );

        for (let i = 0; i < _addresses.length; i++) {
            const address = _addresses[i];
            let userConfigurationInt = parseInt(
                userConfiguration[i].toString()
            );

            if (!Number.isNaN(userConfigurationInt)) {
                const userConfigurationBinary =
                    common.intToBinary(userConfigurationInt);

                results.push({
                    ...userAccountObjects[i],
                    address: address,
                    userConfiguration: userConfigurationBinary,
                    network: this.getAaveNetworkString(network),
                });
            }
        }

        return results;
    }

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

    checkMulticallInputs(
        targetAddresses: string | string[],
        paramAddresses: string | string[] | null,
        contractABIsKeys: string | string[],
        methodNames: string | string[],
        network: Network
    ): [string[], string[], string[], string[]] {
        if (!network) throw new Error("No network provided");
        if (!paramAddresses) paramAddresses = [];

        if (!targetAddresses || targetAddresses.length == 0)
            throw new Error("No targetAddresses provided");

        if (!Array.isArray(targetAddresses))
            targetAddresses = [targetAddresses];

        if (!Array.isArray(methodNames)) methodNames = [methodNames];

        if (targetAddresses.length == 1 && paramAddresses.length > 1) {
            for (let i = 1; i < paramAddresses.length; i++) {
                targetAddresses.push(targetAddresses[0]);
            }
        } else if (targetAddresses.length == 1 && methodNames.length > 1) {
            for (let i = 1; i < methodNames.length; i++) {
                targetAddresses.push(targetAddresses[0]);
            }
        }

        if (!Array.isArray(paramAddresses)) paramAddresses = [paramAddresses];

        if (
            paramAddresses.length == 1 &&
            targetAddresses &&
            targetAddresses.length > 1
        ) {
            for (let i = 1; i < targetAddresses.length; i++) {
                paramAddresses.push(paramAddresses[0]);
            }
        }

        if (
            paramAddresses.length > 0 &&
            targetAddresses.length != paramAddresses.length
        ) {
            throw new Error(
                "targetAddresses and paramAddresses length mismatch"
            );
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

        return [targetAddresses, paramAddresses, contractABIsKeys, methodNames];
    }

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
        paramAddresses: string | string[] | null,
        contractABIsKeys: string | string[],
        methodNames: string | string[],
        network: Network,
        estimateGas: boolean = false
    ) {
        [targetAddresses, paramAddresses, contractABIsKeys, methodNames] =
            this.checkMulticallInputs(
                targetAddresses,
                paramAddresses,
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
                    !paramAddresses || paramAddresses.length == 0
                        ? contractInterface.encodeFunctionData(
                              methodNames[index]
                          )
                        : contractInterface.encodeFunctionData(
                              methodNames[index],
                              Array.isArray(paramAddresses[index])
                                  ? paramAddresses[index]
                                  : [paramAddresses[index]]
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
        const CHUNK_SIZE = 1000;
        const callBatches = _.chunk(calls, CHUNK_SIZE);

        // Create a tracking array to map chunk results back to original indices
        const callIndices = Array.from({ length: calls.length }, (_, i) => i);
        const indexBatches = _.chunk(callIndices, CHUNK_SIZE);

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

    getAaveNetworkInfo(network: Network) {
        if (!network) throw new Error("No network provided");
        const key = this.getAaveNetworkString(network);
        let obj = this.aave[key];
        if (!obj) {
            throw new Error(`Aave network info not found for network ${key}`);
        }
        return obj;
    }

    getHealthFactorFromUserAccountData(userAccountData: any) {
        const healthFactorStr = formatUnits(userAccountData[5], 18);
        return parseFloat(healthFactorStr);
    }

    getContract(address: string, contractAbi: any, network: Network) {
        const networkInfo = this.getAaveNetworkInfo(network);
        return new ethers.Contract(
            address,
            contractAbi,
            networkInfo.alchemyProvider
        );
    }

    async checkLiquidateAddresses(addresses: string[], network: Network) {
        if (addresses.length > 0) {
            //TODO check if there are profitable liquidation opportunities
            const profitableLiquidationAddresses = [];

            if (profitableLiquidationAddresses.length > 0) {
                await emailManager.sendLogEmail(
                    "Liquidation triggered",
                    "Addresses: " + addresses.join(", ")
                );
                //TODO MIRKO implement liquidation logic
                // const aaveNetworkInfo = this.getAaveNetworkInfo(network);
                // const poolContract = this.getContract(
                //     aaveNetworkInfo.addresses.pool,
                //     Constants.ABIS.POOL_ABI,
                //     network
                // );
            }
        }
    }

    //#endregion Helper methods

    //#region Scheduled azure functions

    /**
     * This method should be scheduled to run every day at midnight, since data does should change very often
     *
     * Periodically update the reserves data in the DB
     *
     * @param context the InvocationContext of the function app on azure (for Application Insights)
     */
    async updateReservesData(context: InvocationContext | null = null) {
        //#region initialization

        logger.initialize(
            "function:updateReservesData",
            LoggingFramework.ApplicationInsights,
            context
        );

        await logger.log("Start updateReservesData", "functionAppExecution");
        await this.initializeAlchemy();
        await this.initializeReserves();

        //#endregion initialization

        for (const aaveNetworkInfo of Constants.AAVE_NETWORKS_INFOS) {
            const key = this.getAaveNetworkString(aaveNetworkInfo);

            const results = await this.multicall(
                aaveNetworkInfo.addresses.poolDataProvider,
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
                aaveNetworkInfo.addresses.poolDataProvider,
                _.map(allReserveTokens, (o) => o.address),
                "POOL_DATA_PROVIDER_ABI",
                "getReserveTokensAddresses",
                aaveNetworkInfo.network
            );

            //const reserveTokenAddresses = results[1][0];
            for (let i = 0; i < reserveTokenAddresses.length; i++) {
                allReserveTokens[i].atokenaddress =
                    reserveTokenAddresses[i][0].toString();
                allReserveTokens[i].stabledebttokenaddress =
                    reserveTokenAddresses[i][1].toString();
                allReserveTokens[i].variabledebttokenaddress =
                    reserveTokenAddresses[i][2].toString();
            }

            const allReserveTokensAddresses = _.map(
                allReserveTokens,
                (o) => o.address
            );

            const reservesData1 = await this.multicall(
                aaveNetworkInfo.addresses.poolDataProvider,
                allReserveTokensAddresses,
                "POOL_DATA_PROVIDER_ABI",
                "getReserveData",
                aaveNetworkInfo.network
            );

            for (let i = 0; i < reservesData1.length; i++) {
                allReserveTokens[i].liquidityindex =
                    reservesData1[i][9].toString();
                allReserveTokens[i].variableborrowindex =
                    reservesData1[i][10].toString();
                allReserveTokens[i].liquidityrate =
                    reservesData1[i][5].toString();
                allReserveTokens[i].variableborrowrate =
                    reservesData1[i][6].toString();
                allReserveTokens[i].totalstabledebt =
                    reservesData1[i][3].toString();
                allReserveTokens[i].lastupdatetimestamp =
                    reservesData1[i][11].toString();
                allReserveTokens[i].totalvariabledebt =
                    reservesData1[i][4].toString();
            }

            const reservesConfigData1 = await this.multicall(
                aaveNetworkInfo.addresses.poolDataProvider,
                allReserveTokensAddresses,
                "POOL_DATA_PROVIDER_ABI",
                "getReserveConfigurationData",
                aaveNetworkInfo.network
            );

            for (let i = 0; i < reservesConfigData1.length; i++) {
                allReserveTokens[i].decimals = reservesConfigData1[i][0];
                allReserveTokens[i].ltv = reservesConfigData1[i][1].toString();
                allReserveTokens[i].reserveliquidationthreshold =
                    reservesConfigData1[i][2].toString();
                allReserveTokens[i].reserveliquidationbonus =
                    reservesConfigData1[i][3].toString();
                allReserveTokens[i].reservefactor =
                    reservesConfigData1[i][4].toString();
                allReserveTokens[i].usageascollateralenabled =
                    sqlManager.getBitFromBoolean(reservesConfigData1[i][5]);
                allReserveTokens[i].borrowingenabled =
                    sqlManager.getBitFromBoolean(reservesConfigData1[i][6]);
                allReserveTokens[i].stableborrowrateenabled =
                    sqlManager.getBitFromBoolean(reservesConfigData1[i][7]);
                allReserveTokens[i].isactive = sqlManager.getBitFromBoolean(
                    reservesConfigData1[i][8]
                );
                allReserveTokens[i].isfrozen = sqlManager.getBitFromBoolean(
                    reservesConfigData1[i][9]
                );
            }

            //check if there are reserves in the DB which are not in the reservesList
            //and in case delete them from the DB
            const currentDbReservesAddresses = _.map(
                aaveNetworkInfo.reserves,
                (o) => o.address
            );
            const fetchedReservesAddresses = _.map(
                allReserveTokens,
                (o) => o.address
            );

            const removedReservesAddresses = _.difference(
                currentDbReservesAddresses,
                fetchedReservesAddresses
            );
            if (removedReservesAddresses.length > 0) {
                const sqlQuery = `DELETE FROM reserves WHERE address IN ('${removedReservesAddresses.join(
                    "','"
                )}') AND network = '${key}';`;
                await sqlManager.execQuery(sqlQuery);
            }

            //prepare query to update reserves list in DB
            //and update DB
            let reservesSQLList: string[] = _.map(
                allReserveTokens,
                (o, index) => {
                    return `('${o.address}', '${key}', '${o.symbol}', ${
                        o.decimals
                    }, '${o.reserveliquidationthreshold}', '${
                        o.reserveliquidationbonus
                    }', '${o.reservefactor}', ${
                        o.usageascollateralenabled
                    }, ${sqlManager.getBitFromBoolean(
                        o.borrowingenabled
                    )}, ${sqlManager.getBitFromBoolean(
                        o.stableborrowrateenabled
                    )}, ${sqlManager.getBitFromBoolean(
                        o.isactive
                    )}, ${sqlManager.getBitFromBoolean(o.isfrozen)}, '${
                        o.liquidityindex
                    }', '${o.variableborrowindex}', '${o.liquidityrate}', '${
                        o.variableborrowrate
                    }', '${o.lastupdatetimestamp}', '${o.atokenaddress}','${
                        o.variabledebttokenaddress
                    }', '${o.stabledebttokenaddress}', '${
                        o.totalstabledebt
                    }', '${o.totalvariabledebt}', '${o.ltv}', ${index})`;
                }
            );

            if (reservesSQLList.length > 0) {
                const sqlQuery = `
                    MERGE INTO reserves AS target
                    USING (VALUES 
                        ${reservesSQLList.join(",")}
                    ) AS source (address, network, symbol, decimals, reserveliquidationtreshold, reserveliquidationbonus, reservefactor, usageascollateralenabled, borrowingenabled, stableborrowrateenabled, isactive, isfrozen, liquidityindex, variableborrowindex, liquidityrate, variableborrowrate, lastupdatetimestamp, atokenaddress, variabledebttokenaddress, stabledebttokenaddress, totalstabledebt, totalvariabledebt, ltv, sorting)
                    ON (target.address = source.address AND target.network = source.network)
                    WHEN MATCHED THEN
                    UPDATE SET                        
                        symbol = source.symbol,
                        decimals = source.decimals,                        
                        reserveliquidationtreshold = source.reserveliquidationtreshold,
                        reserveliquidationbonus = source.reserveliquidationbonus,
                        reservefactor = source.reservefactor,
                        usageascollateralenabled = source.usageascollateralenabled,
                        borrowingenabled = source.borrowingenabled,
                        stableborrowrateenabled = source.stableborrowrateenabled,
                        isactive = source.isactive,
                        isfrozen = source.isfrozen,
                        liquidityindex = source.liquidityindex,
                        variableborrowindex = source.variableborrowindex,
                        liquidityrate = source.liquidityrate,
                        variableborrowrate = source.variableborrowrate,                        
                        lastupdatetimestamp = source.lastupdatetimestamp,
                        atokenaddress = source.atokenaddress,
                        variabledebttokenaddress = source.variabledebttokenaddress,
                        stabledebttokenaddress = source.stabledebttokenaddress,
                        totalstabledebt = source.totalstabledebt,
                        totalvariabledebt = source.totalvariabledebt,
                        ltv = source.ltv,
                        sorting = source.sorting
                    WHEN NOT MATCHED BY TARGET THEN
                        INSERT (address, network, symbol, decimals, reserveliquidationtreshold, reserveliquidationbonus, reservefactor, usageascollateralenabled, borrowingenabled, stableborrowrateenabled, isactive, isfrozen, liquidityindex, variableborrowindex, liquidityrate, variableborrowrate, lastupdatetimestamp, atokenaddress, variabledebttokenaddress, stabledebttokenaddress, totalstabledebt, totalvariabledebt, ltv, sorting)
                        VALUES (source.address, source.network, source.symbol, source.decimals, source.reserveliquidationtreshold, source.reserveliquidationbonus, source.reservefactor, source.usageascollateralenabled, source.borrowingenabled, source.stableborrowrateenabled, source.isactive, source.isfrozen, source.liquidityindex, source.variableborrowindex, source.liquidityrate, source.variableborrowrate, source.lastupdatetimestamp, source.atokenaddress, source.variabledebttokenaddress, source.stabledebttokenaddress, source.totalstabledebt, source.totalvariabledebt, source.ltv, source.sorting);
                `;

                //console.log(sqlQuery);
                await sqlManager.execQuery(sqlQuery);
            }
        }

        await logger.log("Ended updateReservesData", "functionAppExecution");
    }

    /**
     * This method should be scheduled to run every 2-3 hours
     *
     * Periodically fetches
     * - userAccountData
     * - userConfiguration
     * - debt tokens amounts
     * for all addresses in the DB with health factor < 2
     */
    async updateUserAccountDataAndUserReserves(
        context: InvocationContext | null = null
    ) {
        //#region initialization

        logger.initialize(
            "function:updateHealthFactorAndUserReserves",
            LoggingFramework.ApplicationInsights,
            context
        );

        await logger.log(
            "Start updateHealthFactorAndUserReserves",
            "functionAppExecution"
        );

        await this.initializeAlchemy();
        await this.initializeReserves();

        //#endregion initialization

        for (const aaveNetworkInfo of Constants.AAVE_NETWORKS_INFOS) {
            const key = this.getAaveNetworkString(aaveNetworkInfo);
            const dbAddressesArr = await sqlManager.execQuery(
                `SELECT * FROM addresses where network = '${key}';`
            );
            const _addresses = _.map(dbAddressesArr, (a: any) => a.address);

            const results = await this.getUserAccountDataForAddresses(
                _addresses,
                aaveNetworkInfo.network
            );

            //Save data to the DB:
            //NOTE: it is not necessary to save the totaldebtbase to the DB, since
            //it will be calculated anyway from the usersreserves data.
            //I leave it here anyway for now, since it is not a big deal to save it
            let deleteAddresses: string[] = [];
            const chunks = _.chunk(results, 1000);
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];

                let query =
                    chunk.length > 0
                        ? `
                UPDATE addresses 
                SET 
                    healthfactor = CASE
                        {0}
                    ELSE healthfactor
                    END,                                        
                    totalcollateralbase = CASE
                        {1}
                    ELSE totalcollateralbase
                    END,
                    totaldebtbase = CASE
                        {2}
                    ELSE totaldebtbase
                    END
                WHERE address IN ({3}) AND network = '${key}';
            `
                        : "";

                let arr0 = [];
                let arr1 = [];
                let arr2 = [];
                let arr3 = [];
                for (let i = 0; i < chunk.length; i++) {
                    if (chunk[i].healthFactor < 2) {
                        arr0.push(
                            `WHEN address = '${chunk[i].address}' AND network = '${key}' THEN ${chunk[i].healthFactor}`
                        );
                        arr1.push(
                            `WHEN address = '${chunk[i].address}' AND network = '${key}' THEN '${chunk[i].totalCollateralBase}'`
                        );
                        arr2.push(
                            `WHEN address = '${chunk[i].address}' AND network = '${key}' THEN '${chunk[i].totalDebtBase}'`
                        );
                        arr3.push(`'${chunk[i].address}'`);
                    } else {
                        deleteAddresses.push(chunk[i].address);
                    }
                }

                query = query.replace("{0}", arr0.join(" "));
                query = query.replace("{1}", arr1.join(" "));
                query = query.replace("{2}", arr2.join(" "));
                query = query.replace("{3}", arr3.join(","));

                if (query) await sqlManager.execQuery(query);
            }

            if (deleteAddresses.length > 0) {
                const chunks = _.chunk(deleteAddresses, 1000);
                for (let i = 0; i < chunks.length; i++) {
                    const sqlQuery = `DELETE FROM addresses WHERE address IN ('${chunks[
                        i
                    ].join("','")}') AND network = '${key}';`;
                    await sqlManager.execQuery(sqlQuery);
                }
            }

            const resultsExceptDeleteds = _.reject(results, (o: any) => {
                return _.includes(deleteAddresses, o.address);
            });

            await this.updateUsersData(resultsExceptDeleteds, aaveNetworkInfo);
        }

        await logger.log(
            "End updateHealthFactorAndUserReserves",
            "functionAppExecution"
        );
    }

    async updateUsersData(resultsObjects: any[], aaveNetworkInfo: any) {
        const key = this.getAaveNetworkString(aaveNetworkInfo);
        const userAddressesObjects = _.filter(resultsObjects, (o) => {
            return o.network == key;
        });

        let multicallUserReserveDataParameters: any[] = [];
        const reservesAddresses = _.keys(aaveNetworkInfo.reserves);
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
            aaveNetworkInfo.addresses.poolDataProvider,
            multicallUserReserveDataParameters,
            "POOL_DATA_PROVIDER_ABI",
            "getUserReserveData",
            aaveNetworkInfo.network
        );

        let sqlQueries: string[] = [];
        const userReserveDataChunks = _.chunk(results, 1000);
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

                let sqlQuery = `                        
                        MERGE INTO usersreserves AS target
                        USING (VALUES 
                            ${_.map(
                                userReservesObjects,
                                (o) =>
                                    `('${o.userAddress}', '${o.tokenAddress}', '${key}', '${o.currentATokenBalance}', '${o.currentStableDebt}', '${o.currentVariableDebt}', '${o.principalStableDebt}', '${o.scaledVariableDebt}', '${o.stableBorrowRate}', '${o.liquidityRate}', '${o.stableRateLastUpdated}', ${o.usageAsCollateralEnabled})`
                            ).join(",")}
                        ) AS source (address, tokenaddress, network, currentatokenbalance, currentstabledebt, currentvariabledebt, principalstabledebt, scaledvariabledebt, stableborrowrate, liquidityrate, stableratelastupdated, usageascollateralenabled)
                        ON (target.address = source.address AND target.tokenaddress = source.tokenaddress AND target.network = source.network)
                        WHEN MATCHED THEN
                        UPDATE SET                        
                            currentatokenbalance = source.currentatokenbalance,
                            currentstabledebt = source.currentstabledebt,
                            currentvariabledebt = source.currentvariabledebt,
                            principalstabledebt = source.principalstabledebt,
                            scaledvariabledebt = source.scaledvariabledebt,
                            stableborrowrate = source.stableborrowrate,
                            liquidityrate = source.liquidityrate,
                            stableratelastupdated = source.stableratelastupdated,
                            usageascollateralenabled = source.usageascollateralenabled                                      
                            WHEN NOT MATCHED BY TARGET THEN
                        INSERT (address, tokenaddress, network, currentatokenbalance, currentstabledebt, currentvariabledebt, principalstabledebt, scaledvariabledebt, stableborrowrate, liquidityrate, stableratelastupdated, usageascollateralenabled)
                        VALUES (source.address, source.tokenaddress, source.network, source.currentatokenbalance, source.currentstabledebt, source.currentvariabledebt, source.principalstabledebt, source.scaledvariabledebt, source.stableborrowrate, source.liquidityrate, source.stableratelastupdated, source.usageascollateralenabled);
                            `;

                sqlQueries.push(sqlQuery);
            }
        }

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

    /**
     *  Gets the newest assets prices for the given network or all networks and updates the prices in the DB if the prices have changed
     *  beyond a certain treshold (currently set at 0.0005 ETH), then it
     *  calculates the health factor for the addresses that have the reserves whose prices have changed, either as collateral or as debt
     *  and liquidates them if their health factor is below 1. The method is defined as a function and called periodically on azure
     *
     * //TODO implement logic to decide which asset pair to liquidate for a given user
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
            `SELECT * FROM addresses WHERE healthfactor < 2;`
        );

        if (allAddressesDb.length == 0) {
            await logger.log("No addresses found in DB with health factor < 2");
            return;
        }

        for (const aaveNetworkInfo of Constants.AAVE_NETWORKS_INFOS) {
            if (network && network != aaveNetworkInfo.network) continue;
            const key = this.getAaveNetworkString(aaveNetworkInfo);
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
                aaveNetworkInfo.addresses.aaveOracle,
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

            //filter the addresses from the DB that have the changed reserves either as collateral or as debt
            if (shouldPerformCheck) {
                //define object (map) of user assets that have the changed reserves either as collateral or as debt
                //userAssets: {address: {collateral: [reserves], debt: [reserves]}}
                let userAssets: any = {};

                //loop through loaded addresses from DB
                for (const addressRecord of addressesDb) {
                    //get user configuration in string format e.g. 100010001100 (it's stored in DB as a string)
                    const userConfiguration = addressRecord.userconfiguration;

                    let i = userConfiguration.length - 1;

                    //loop through reserves
                    for (let reserveChangedCheck of reservesChangedCheck) {
                        //if reserve price has not changed, we skip it
                        if (reserveChangedCheck.check != "none") {
                            if (
                                userConfiguration[i] == "1" &&
                                reserveChangedCheck.check == "debt"
                            ) {
                                if (
                                    !userAssets.hasOwnProperty(
                                        addressRecord.address
                                    )
                                )
                                    userAssets[addressRecord.address] = {};
                                if (
                                    !userAssets[
                                        addressRecord.address
                                    ].hasOwnProperty("debt")
                                )
                                    userAssets[addressRecord.address].debt = [];

                                userAssets[addressRecord.address].debt.push(
                                    reserveChangedCheck.reserve
                                );
                            } else if (
                                i > 0 &&
                                userConfiguration[i - 1] == "1" &&
                                reserveChangedCheck.check == "collateral"
                            ) {
                                if (
                                    !userAssets.hasOwnProperty(
                                        addressRecord.address
                                    )
                                )
                                    userAssets[addressRecord.address] = {};
                                if (
                                    !userAssets[
                                        addressRecord.address
                                    ].hasOwnProperty("collateral")
                                )
                                    userAssets[
                                        addressRecord.address
                                    ].collateral = [];

                                userAssets[
                                    addressRecord.address
                                ].collateral.push(reserveChangedCheck.reserve);
                            }
                        }
                        i = i - 2;
                    }
                }

                //get list of addresses for which to check health factor from the userAssets object
                const addressesToCheck = Object.keys(userAssets);

                //check the health factor for the addresses that have the changed reserves either as collateral or as debt
                if (addressesToCheck.length > 0) {
                    let addressesToLiquidate: any[] = [];

                    //iterate through the results and check the health factor of corresponding address
                    for (let i = 0; i < addressesToCheck.length; i++) {
                        //get address and health factor
                        const address = addressesToCheck[i];
                        const healthFactor =
                            this.getHealthFactorOffChain(address);

                        //if health factor is below 1, we add the address to the list of addresses to liquidate
                        if (healthFactor < 1) {
                            //decide which asset pair to liquidate for the user based on the userAssets collateral and debt properties
                            const assetsToLiquidate: string[] =
                                await this.decideWhichAssetPairToLiquidate(
                                    address,
                                    userAssets[address]
                                );

                            //add the address to the list of addresses to liquidate
                            addressesToLiquidate.push({
                                address: address,
                                assets: assetsToLiquidate,
                            });
                        }
                    }

                    //Trigger liquidation
                    if (addressesToLiquidate.length > 0) {
                        this.checkLiquidateAddresses(
                            addressesToLiquidate,
                            aaveNetworkInfo.network
                        );
                    } else {
                        await logger.log(
                            `No addresses to liquidate, out of ${addressesToLiquidate.length} addresses`
                        );
                    }
                }
            } else {
                await logger.log("No price changes detected");
            }

            if (reservesDbUpdate.length > 0) {
                let reservesSQLList: string[] = _.map(reservesDbUpdate, (o) => {
                    return `('${o.address}', '${key}', ${o.price})`;
                });

                if (reservesSQLList.length > 0) {
                    const sqlQuery = `
                    MERGE INTO reserves AS target
                    USING (VALUES 
                        ${reservesSQLList.join(",")}
                    ) AS source (address, network, price)
                    ON (target.address = source.address AND target.network = source.network)
                    WHEN MATCHED THEN
                    UPDATE SET                        
                        price = source.price;                        
                        `;

                    await sqlManager.execQuery(sqlQuery);
                } else {
                    //we should actually never come here, but just in case
                    throw new Error(
                        "reservesSQLList is empty despite reservesDbUpdate being not empty"
                    );
                }
            }
        }

        await logger.log("End updateTokensPrices");
    }

    /**
     * deletes old entries from the logs table older than 2 days
     * so that the table does not grow indefinitely
     *
     * @param context the InvocationContext of the function app (for Application Insights logging)
     */
    async deleteOldTableLogs(context: InvocationContext) {
        logger.initialize(
            "function:deleteOldTableLogs",
            LoggingFramework.ApplicationInsights,
            context
        );
        await logger.log("Started function deleteOldTableLogs");
        const query = `DELETE FROM dbo.logs WHERE timestamp < DATEADD(DAY, -2, GETDATE())`;
        await sqlManager.execQuery(query);
        await logger.log("Ended function deleteOldTableLogs");
    }

    //#endregion Scheduled azure functions

    //#region Testing methods

    async doTest() {
        await this.initializeAlchemy();
        await this.initializeReserves();
        await this.initializeUsersReserves();

        /*
        await this.updateReservesData();
        await this.updateUserAccountDataAndUserReserves();
        */
        /*
        const users = ["0xe24f48680a17bf0060b79b1902708d4f7083b31c"];
        const data = await this.getUserAccountDataForAddresses(
            users,
            Network.ARB_MAINNET
        );
        */
        const network: Network = Network.ARB_MAINNET;
        const aaveNetworkInfo = this.getAaveNetworkInfo(network);

        const totalDebtCalculated = this.calculateTotalDebtBaseForAddress(
            "0x3a2f790e3ff03492e34bcd7ce557e76b0cc17d55",
            network
        );

        console.log(totalDebtCalculated);

        const poolDataProviderContract = this.getContract(
            aaveNetworkInfo.addresses.poolDataProvider,
            Constants.ABIS.POOL_DATA_PROVIDER_ABI,
            network
        );

        const poolContract = this.getContract(
            aaveNetworkInfo.addresses.pool,
            Constants.ABIS.POOL_ABI,
            network
        );

        const userAccountData = await poolContract.getUserAccountData(
            "0x3a2f790e3ff03492e34bcd7ce557e76b0cc17d55"
        );
        console.log(userAccountData);

        /*
        let reservesKeys = _.keys(aaveNetworkInfo.reserves);
        let multicallUserReserveDataParameters: any[] = [];
        multicallUserReserveDataParameters.push([
            reservesKeys[0],
            "0x3a2f790e3ff03492e34bcd7ce557e76b0cc17d55",
        ]);

        const results = await this.multicall(
            aaveNetworkInfo.addresses.poolDataProvider,
            multicallUserReserveDataParameters,
            "POOL_DATA_PROVIDER_ABI",
            "getUserReserveData",
            aaveNetworkInfo.network
        );

        console.log(results);

        const addresses = [
            "0x3a2f790e3ff03492e34bcd7ce557e76b0cc17d55",

            "0x803e113d2c53e3cd8777e52b027920315ed1b5e0",
            "0xbbc233f5422bbeb0be4d5fc51f324aeb4a028eb1",
            "0x21c7ff5562979c4ee7db6adec86cb3765083002a",
            "0x767522b55c5760ae16173b620fdf20186e883486",
            "0x5dbb8becb93e9ec3ada7c70f522aa798bb7fd882",
            "0x76328f7620f4de1d19bbbd29db34c79d663a5217",
            "0xc1cf20874d72fe452fd5982917fe0ab209305121",
            "0x0604e652a188931e245717d45feb26f583b92908",
            "0x280a9ee48968d3b2b7fab15c8ee09d7205675f76",
        ];
        */
    }

    //#endregion Testing methods
}

export default Engine.getInstance();
