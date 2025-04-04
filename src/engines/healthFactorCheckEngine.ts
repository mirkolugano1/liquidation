import common from "../shared/common";
import _ from "lodash";
import encryption from "../shared/encryption";
import sqlManager from "../managers/sqlManager";
import { ethers, formatUnits } from "ethers";
import Big from "big.js";
import logger from "../shared/logger";
import { InvocationContext } from "@azure/functions";
import { LoggingFramework } from "../shared/enums";
import Constants from "../shared/constants";
import { Alchemy, Network } from "alchemy-sdk";

class HealthFactorCheckEngine {
    private static instance: HealthFactorCheckEngine;
    private constructor() {}

    public static getInstance(): HealthFactorCheckEngine {
        if (!HealthFactorCheckEngine.instance) {
            HealthFactorCheckEngine.instance = new HealthFactorCheckEngine();
        }
        return HealthFactorCheckEngine.instance;
    }

    //#region Initialization

    async initializeReserves() {
        if (!this.aave) throw new Error("Aave object not initialized");

        const dbReserves = await sqlManager.execQuery(
            `SELECT * FROM reserves;`
        );
        if (!dbReserves || dbReserves.length == 0) {
            await logger.log(
                "No reserves found in DB. Please run the updateReservesConfiguration function first.",
                "functionAppExecution"
            );
            return;
        }

        let reserves: any = {};
        for (const aaveChainInfo of Constants.AAVE_CHAINS_INFOS) {
            const key = `${aaveChainInfo.chain}-${aaveChainInfo.chainEnv}`;
            const chainReserves = _.filter(dbReserves, { chain: key });
            for (let chainReserve of chainReserves) {
                reserves[chainReserve.address] = chainReserve;
            }
            this.aave[key] = _.assign(aaveChainInfo, { reserves: reserves });
        }
    }

    async initializeAlchemy() {
        if (this.aave) return;
        this.aave = {};

        const alchemyKey = await encryption.getAndDecryptSecretFromKeyVault(
            "ALCHEMYKEYENCRYPTED"
        );
        /*
        const alchemyFromAddress = await common.getAppSetting(
            "ALCHEMY_FROM_ADDRESS"
        );
        const privateKey = await encryption.getAndDecryptSecretFromKeyVault(
            "PRIVATEKEYENCRYPTED"
        );
        */

        if (!alchemyKey) {
            await logger.log(
                "No Alchemy key found. Please set the ALCHEMYKEYENCRYPTED environment variable.",
                "functionAppExecution"
            );
            return;
        }

        for (const aaveChainInfo of Constants.AAVE_CHAINS_INFOS) {
            const key = `${aaveChainInfo.chain}-${aaveChainInfo.chainEnv}`;

            const config = {
                apiKey: alchemyKey, // Replace with your API key
                network: (Network as any)[key.replace("-", "_").toUpperCase()], // Replace with your network
            };
            const alchemy = new Alchemy(config);
            const alchemyProvider = await alchemy.config.getProvider();

            let chainInfo: any = _.assign(aaveChainInfo, {
                alchemy: alchemy,
                alchemyProvider: alchemyProvider,
            });

            this.aave[key] = chainInfo;
        }
    }

    //#endregion Initialization

    //#region Variables

    aave: any;
    oldReservesPrices: any;

    //#endregion Variables

    //#region Helper methods

    getAaveChainInfo(chain: string, chainEnv: string = "mainnet") {
        const key = `${chain}-${chainEnv}`;
        let obj = this.aave[key];
        if (!obj) {
            throw new Error(
                `Aave chain info not found for chain ${chain} and env ${chainEnv}`
            );
        }
        return obj;
    }

    getHealthFactorFromUserAccountData(userAccountData: any) {
        const healthFactorStr = formatUnits(userAccountData[5], 18);
        return parseFloat(healthFactorStr);
    }

    getContract(
        address: string,
        contractAbi: any,
        chain: string,
        chainEnv: string
    ) {
        const chainInfo = this.getAaveChainInfo(chain, chainEnv);
        return new ethers.Contract(
            address,
            contractAbi,
            chainInfo.alchemyProvider
        );
    }

    //#endregion Helper methods

    /**
     * Periodically update the reserves configuration in the DB
     * so that we don't need to fetch it from the blockchain every time
     *
     * @param context the InvocationContext of the function app on azure (for Application Insights)
     */
    async updateReservesConfiguration(
        context: InvocationContext | null = null
    ) {
        //#region initialization

        logger.initialize(
            "function:updateReservesConfiguration",
            LoggingFramework.ApplicationInsights,
            context
        );

        await logger.log(
            "Start updateReservesConfiguration",
            "functionAppExecution"
        );
        await this.initializeAlchemy();
        await this.initializeReserves();

        //#endregion initialization

        for (const chainInfo of Constants.AAVE_CHAINS_INFOS) {
            const key = `${chainInfo.chain}-${chainInfo.chainEnv}`;
            const aaveChainInfo = this.getAaveChainInfo(
                chainInfo.chain,
                chainInfo.chainEnv
            );

            //get current list of reserves from the chain
            const uiPoolDataProviderContract = this.getContract(
                aaveChainInfo.addresses.uiPoolDataProvider,
                Constants.UI_POOL_DATA_PROVIDER_ABI,
                chainInfo.chain,
                chainInfo.chainEnv
            );
            const [reservesData, baseCurrencyInfo] =
                await uiPoolDataProviderContract.getReservesData(
                    chainInfo.addresses.poolAddressesProvider
                );

            //mirko parse new data

            if (!reservesData || reservesData.length == 0) {
                await logger.log(
                    `No reserves found for chain ${chainInfo.chain} and env ${chainInfo.chainEnv}`,
                    "functionAppExecution"
                );
                return;
            }

            //check if there are reserves in the DB which are not in the reservesList
            //and in case delete them from the DB
            const currentDbReservesAddresses = _.map(
                aaveChainInfo.reserves,
                (o) => o.address
            );
            const fetchedReservesAddresses = _.map(
                reservesData,
                (o) => o.address
            );

            const removedReservesAddresses = _.difference(
                currentDbReservesAddresses,
                fetchedReservesAddresses
            );
            if (removedReservesAddresses.length > 0) {
                const sqlQuery = `DELETE FROM reserves WHERE address IN ('${removedReservesAddresses.join(
                    "','"
                )}') AND chain = '${key}';`;
                await sqlManager.execQuery(sqlQuery);
            }

            //prepare query to update reserves list in DB
            //and update DB
            let reservesSQLList: any[] = [];
            for (let i = 0; i < reservesData.length; i++) {
                const reserveData = reservesData[i];
                reservesSQLList.push(
                    `('${reserveData[0]}', 
                        '${key}', 
                        '${reserveData[1]}',
                        '${reserveData[2]}',
                        ${reserveData[3]},
                        ${reserveData[4]},
                        ${reserveData[5]},
                        ${reserveData[6]},
                        ${reserveData[7]},
                        '${sqlManager.getBitFromBoolean(reserveData[8])}',
                        '${sqlManager.getBitFromBoolean(reserveData[9])}',
                        '${sqlManager.getBitFromBoolean(reserveData[10])}',
                        '${sqlManager.getBitFromBoolean(reserveData[11])}',
                        '${sqlManager.getBitFromBoolean(reserveData[12])}',
                        ${reserveData[13]},
                        ${reserveData[14]},
                        ${reserveData[15]},
                        ${reserveData[16]},
                        ${reserveData[17]},
                        ${reserveData[18]},
                        '${reserveData[19]}',
                        '${reserveData[20]}',
                        '${reserveData[21]}',
                        '${reserveData[22]}',)`
                );
            }

            if (reservesSQLList.length > 0) {
                const sqlQuery = `
                    MERGE INTO reserves AS target
                    USING (VALUES 
                        ${reservesSQLList.join(",")}
                    ) AS source (address, chain, name, symbol, decimals, baseltvascollateral, reserveliquidationtreshold, reserveliquidationbonus, reservefactor, usageascollateralenabled, borrowingenabled, stableborrowrateenabled, isactive, isfrozen, liquidityindex, variableborrowindex, liquidityrate, variableborrowrate, stableborrowrate, lastupdatetimestamp, atokenaddress, stabledebttokenaddress, variabledebttokenAddress, intereststrategyaddress)
                    ON (target.address = source.address AND target.chain = source.chain)
                    WHEN NOT MATCHED BY TARGET THEN
                        INSERT (address, chain, name, symbol, decimals, baseltvascollateral, reserveliquidationtreshold, reserveliquidationbonus, reservefactor, usageascollateralenabled, borrowingenabled, stableborrowrateenabled, isactive, isfrozen, liquidityindex, variableborrowindex, liquidityrate, variableborrowrate, stableborrowrate, lastupdatetimestamp, atokenaddress, stabledebttokenaddress, variabledebttokenAddress, intereststrategyaddress)
                        VALUES (source.address, source.chain, source.name, source.symbol, source.decimals, source.baseltvascollateral, source.reserveliquidationtreshold, source.reserveliquidationbonus, source.reservefactor, source.usageascollateralenabled, source.borrowingenabled, source.stableborrowrateenabled, source.isactive, source.isfrozen, source.liquidityindex, source.variableborrowindex, source.liquidityrate, source.variableborrowrate, source.stableborrowrate, source.lastupdatetimestamp, source.atokenaddress, source.stabledebttokenaddress, source.variabledebttokenAddress, source.intereststrategyaddress);
                `;

                await sqlManager.execQuery(sqlQuery);
            }
        }

        await logger.log(
            "Ended updateReservesConfiguration",
            "functionAppExecution"
        );
    }

    //#region healthFactor DB check loop

    checkReservesPricesIntervalId: any;
    checkReservesPricesIntervalInSeconds = 60 * 5; // 5 minutes, for the moment...

    async startCheckReservesPrices() {
        await this.initializeAlchemy();
        await this.initializeReserves();
        for (const chainInfo of Constants.AAVE_CHAINS_INFOS) {
            await this.checkReservesPrices(chainInfo.chain, chainInfo.chainEnv); // Initial call
            this.checkReservesPricesIntervalId = setInterval(async () => {
                await this.initializeReserves();
                await this.checkReservesPrices(
                    chainInfo.chain,
                    chainInfo.chainEnv
                );
            }, this.checkReservesPricesIntervalInSeconds * 1000);
        }

        // Graceful shutdown
        process.on("SIGTERM", this.stopCheckReservesPrices.bind(this));
        process.on("SIGINT", this.stopCheckReservesPrices.bind(this));
    }

    stopCheckReservesPrices() {
        if (this.checkReservesPricesIntervalId) {
            clearInterval(this.checkReservesPricesIntervalId);
        }
    }

    async getHealthFactorAndConfigurationForAddresses(
        _addresses: string[],
        chain: string,
        chainEnv: string = "mainnet"
    ) {
        if (!_addresses || _addresses.length == 0) return [];

        let results: any[] = [];

        const chainInfo = await this.getAaveChainInfo(chain, chainEnv);

        const userAccountData = await this.batchEthCall(
            chainInfo.addresses.pool,
            _addresses,
            Constants.POOL_ABI,
            "getUserAccountData",
            chain,
            chainEnv
        );

        const userConfiguration = await this.batchEthCall(
            chainInfo.addresses.pool,
            _addresses,
            Constants.POOL_ABI,
            "getUserConfiguration",
            chain,
            chainEnv
        );

        for (let i = 0; i < _addresses.length; i++) {
            const address = _addresses[i];
            const healthFactor = this.getHealthFactorFromUserAccountData(
                userAccountData[i]
            );
            let userConfigurationInt = parseInt(userConfiguration[i]);

            if (!Number.isNaN(userConfigurationInt)) {
                const userConfigurationBinary =
                    common.intToBinary(userConfigurationInt);

                results.push({
                    address: address,
                    healthFactor: healthFactor,
                    userConfiguration: userConfigurationBinary,
                });
            }
        }

        return results;
    }

    /**
     * This method is used to periodically check the health factor and userConfiguration of the addresses that are stored in the DB,
     * so that the data in the DB is always up to date, up to the interval of the cron job that calls this method.
     * The method does NOT contains an infinite loop. It is meant to be scheduled by a cron job or similar.
     */
    async periodicalAccountsHealthFactorAndConfigurationCheck() {
        await logger.log(
            "Start periodicalAccountsHealthFactorAndConfigurationCheck",
            "functionAppExecution"
        );

        await this.initializeAlchemy();
        for (const info of Constants.AAVE_CHAINS_INFOS) {
            const dbAddressesArr = await sqlManager.execQuery(
                `SELECT * FROM addresses where chain = '${info.chain}-${info.chainEnv}';`
            );
            const _addresses = _.map(dbAddressesArr, (a: any) => a.address);
            const results =
                await this.getHealthFactorAndConfigurationForAddresses(
                    _addresses,
                    info.chain,
                    info.chainEnv
                );

            let query =
                results.length > 0
                    ? `
                UPDATE addresses 
                SET 
                    healthfactor = CASE
                        {0}
                    ELSE healthfactor,
                    END,
                    userconfiguration = CASE
                        {1}
                    ELSE userconfiguration,
                    END,
                WHERE address IN ({2});
            `
                    : "";

            const key = `${info.chain}-${info.chainEnv}`;
            let arr0 = [];
            let arr1 = [];
            let arr2 = [];
            for (let i = 0; i < results.length; i++) {
                arr0.push(
                    `WHEN address = '${results[i].address}' AND chain = '${key}' THEN ${results[i].healthFactor}`
                );
                arr1.push(
                    `WHEN address = '${results[i].address}' AND chain = '${key}' THEN ${results[i].userConfiguration}`
                );
                arr2.push(`'${results[i].address}'`);
                query.replace("{0}", arr0.join(" "));
                query.replace("{1}", arr1.join(" "));
                query.replace("{2}", arr2.join(","));
            }

            if (query) await sqlManager.execQuery(query);
        }

        await logger.log(
            "End periodicalAccountsHealthFactorAndConfigurationCheck",
            "functionAppExecution"
        );
    }

    //#endregion healthFactor DB check loop

    /**
     *  Check the health factor for the addresses that have the reserves whose prices have changed, either as collateral or as debt
     *  and liquidate them if their health factor is below 1. The method contains an infinite loop that checks the reserves prices
     *  every n seconds and if the prices have changed, it checks the health factor for the addresses that have the changed reserves
     *
     * //TODO check Compute Units utilization of method batchEthCall if there are many addresses, evtl split call in smaller chunks
     * //TODO implement logic to decide which asset pair to liquidate for a given user
     * //TODO connect to smart contract for liquidation process
     *
     * @param chain
     * @param chainEnv
     */
    async checkReservesPrices(chain: string, chainEnv: string = "mainnet") {
        await logger.log("Start checkReservesPrices", "functionAppExecution");

        //#region initialization

        const aaveChainInfo: any = this.getAaveChainInfo(chain, chainEnv);
        const reserves = Object.keys(aaveChainInfo.reserves);

        //#endregion

        /*
            check price changes for each reserve
            changes must be relevant to the last price and according to this formula

            Normalized change in ETH = (change in wei) / 10 ** (18 - decimals)

            the normalized change must be > 0.0005 ETH (we could change this according to table below)

            Summary of Recommended Thresholds
            ---------------------------------
            Asset Type	        Normalized Change Threshold (ETH)
            Stablecoins	        0.0001 to 0.001
            Mid-Volatility	    0.0005 to 0.005
            High-Volatility	    0.001 to 0.01
        */

        //#region infinite loop

        //get the prices for the reserves of the lending protocol
        const aaveOracleContract = this.getContract(
            aaveChainInfo.addresses.aaveOracle,
            Constants.AAVE_ORACLE_ABI,
            aaveChainInfo.chain,
            aaveChainInfo.chainEnv
        );
        const prices = await aaveOracleContract.getAssetsPrices(reserves);

        let newReservesPrices: any = {};
        for (let i = 0; i < reserves.length; i++) {
            const reserveAddress = reserves[i];
            const price = prices[i];
            newReservesPrices[reserveAddress] = price;
        }

        //by default we should not perform the check. If price changes are found, we do check
        let shouldPerformCheck = false;

        //if it is the first time we check the prices, we store the current prices as old prices
        if (!this.oldReservesPrices) {
            console.log("No oldReservePrices available");
            this.oldReservesPrices = newReservesPrices;
        } else {
            console.log("OldReservePrices present, checking prices changes");
            //check if the prices have changed for the reserves
            let reservesChangedCheck: any[] = [];
            for (const reserveAddress of reserves) {
                const oldPrice = this.oldReservesPrices[reserveAddress];
                const newPrice = newReservesPrices[reserveAddress];
                const decimals =
                    aaveChainInfo.reserves[reserveAddress].decimals;
                const normalizedChange = new Big(newPrice - oldPrice).div(
                    new Big(10).pow(
                        new Big(18).minus(new Big(decimals)).toNumber()
                    )
                );

                let check = "none";

                //if the normalized change is greater than the given treshold, we should perform the check
                if (normalizedChange.abs().gte(new Big(0.0005))) {
                    console.log(
                        `Price change for reserve ${reserveAddress} is ${normalizedChange.toNumber()}. Old price: ${oldPrice}, new price: ${newPrice}`
                    );

                    //if we come here, it means there is at least 1 changed reserve. We should perform the check
                    //later on all accounts that have the changed reserves either as collateral or as debt
                    //depending if price has gone up or down
                    shouldPerformCheck = true;

                    //add current reserve to the list of changed reserves and check if it should be checked as collateral or a debt
                    check =
                        normalizedChange.toNumber() < 0 ? "collateral" : "debt";

                    //update the old price of the current reserve to the changed price, so that we base our next change detection
                    //on this current price and not the old one
                    this.oldReservesPrices[reserveAddress] = newPrice;
                }

                //add the reserve to the list of changed reserves. If no price change for this reserve has happened, the check will be "none"
                reservesChangedCheck.push({
                    reserve: reserveAddress,
                    check: check,
                });
            }

            //filter the addresses from the DB that have the changed reserves either as collateral or as debt
            if (shouldPerformCheck) {
                //load all addresses from the DB that have health factor < 2 since higher health factors are not interesting
                const addressesDb = await sqlManager.execQuery(
                    `SELECT * FROM addresses where chain = '${aaveChainInfo.chain}-${aaveChainInfo.chainEnv}' AND healthfactor < 2;`
                );

                console.log(
                    "Checking addresses. Loaded addresses with health factor < 2: " +
                        _.map(addressesDb, (o) => o.address)
                );

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
                                //#region check object null property

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

                                //#endregion

                                userAssets[addressRecord.address].debt.push(
                                    reserveChangedCheck.reserve
                                );
                            } else if (
                                i > 0 &&
                                userConfiguration[i - 1] == "1" &&
                                reserveChangedCheck.check == "collateral"
                            ) {
                                //#region check object null property

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

                                //#endregion

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
                    //#region setup array of contract addresses to call with same address multiple times

                    console.log(
                        "addresses that have the changed reserves either as collateral or as debt",
                        addressesToCheck
                    );

                    //#endregion

                    /*
                    //batch call the health factor for the addresses
                    const userAccountData = await this.batchEthCall(
                        aavePoolContractAddress,
                        addressesToCheck,
                        this.aavePoolContractAbi,
                        "getUserAccountData",
                        aaveChainInfo.chain,
                        aaveChainInfo.chainEnv
                    );
*/
                    //TODO calculate HF off-chain
                    const userAccountData: any[] = [];

                    let addressesToLiquidate: any[] = [];

                    //iterate through the results and check the health factor of corresponding address
                    for (let i = 0; i < addressesToCheck.length; i++) {
                        //get address and health factor
                        const address = addressesToCheck[i];
                        const healthFactor =
                            this.getHealthFactorFromUserAccountData(
                                userAccountData[i]
                            );

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
                        //TODO MIRKO liquidate the addresses
                        await logger.log(
                            "Addresses to liquidate: " +
                                JSON.stringify(addressesToLiquidate),
                            "liquidate"
                        );
                    } else {
                        console.log(
                            `No addresses to liquidate, out of ${addressesToLiquidate.length} addresses`
                        );
                    }
                }
            } else {
                console.log("No price changes detected");
            }
        }

        await logger.log("End checkReservesPrices", "functionAppExecution");
    }

    /**
     * Utility function to batch call a method for multiple smartContract addresses
     * or for a single smartContract address with multiple method parameters
     * or both. The method will return an array of results for each call.
     * Important is, if methodParams is defined, it must be same length of contractsAddresses
     *
     * @param contractsAddresses string[], the smartContract addresses
     * @param methodParams string[] | null, the method parameters for each smartContract address
     * @param contractAbi any, the smartContract ABI of the function to be called
     * @param methodName string, the method name to be called
     * @param chain string, the chain name (eth, arb, etc)
     * @param chainEnv string, the chain environment (mainnet, kovan, etc)
     * @returns Array of results for each smartContract call
     */
    async batchEthCall(
        contractsAddresses: string | string[],
        targetsAddresses: string | string[] | null,
        contractAbi: any,
        methodName: string,
        chain: string,
        chainEnv: string = "mainnet"
    ) {
        if (!contractsAddresses || contractsAddresses.length == 0)
            throw new Error("No contractsAddresses provided");
        if (!Array.isArray(contractsAddresses))
            contractsAddresses = [contractsAddresses];

        if (targetsAddresses) {
            if (!Array.isArray(targetsAddresses))
                targetsAddresses = [targetsAddresses];

            if (contractsAddresses.length == 1) {
                for (let i = 1; i < targetsAddresses.length; i++) {
                    contractsAddresses.push(contractsAddresses[0]);
                }
            } else if (targetsAddresses.length == 1) {
                for (let i = 1; i < contractsAddresses.length; i++) {
                    targetsAddresses.push(targetsAddresses[0]);
                }
            }

            if (contractsAddresses.length != targetsAddresses.length)
                throw new Error(
                    "contractsAddresses and methodParams length mismatch"
                );
        }

        const chainInfo = this.getAaveChainInfo(chain, chainEnv);
        const contractInterface = new ethers.Interface(contractAbi);
        const batchRequests = contractsAddresses.map(
            (contractAddress, index) => ({
                jsonrpc: "2.0",
                method: "eth_call",
                params: [
                    {
                        to: contractAddress,
                        data: targetsAddresses
                            ? contractInterface.encodeFunctionData(methodName, [
                                  targetsAddresses[index],
                              ])
                            : contractInterface.encodeFunctionData(methodName),
                    },
                    "latest",
                ],
                id: index,
            })
        );

        //const response = await chainInfo.alchemyProvider.send(batchRequests);
        const providerUrl = chainInfo.alchemyProvider.connection.url;
        const response = await fetch(providerUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(batchRequests),
        });

        const results = await response.json();

        // Decode the results
        const decodedResults = results.map((result: any) => {
            if (result.error) {
                return { error: result.error };
            }
            return contractInterface.decodeFunctionResult(
                methodName,
                result.result
            );
        });

        if (
            Array.isArray(decodedResults[0]) &&
            Array.isArray(decodedResults[0][0])
        )
            return decodedResults[0][0];
        else return decodedResults;
    }

    //#region test

    async doTest(chain: string, chainEnv: string = "mainnet") {
        await this.initializeAlchemy();

        const chainInfo = this.getAaveChainInfo(chain, chainEnv);
        const key = `${chainInfo.chain}-${chainInfo.chainEnv}`;
        const aaveChainInfo = this.getAaveChainInfo(
            chainInfo.chain,
            chainInfo.chainEnv
        );

        //mirko
        const uiPoolDataProviderContract = this.getContract(
            aaveChainInfo.addresses.uiPoolDataProvider,
            Constants.UI_POOL_DATA_PROVIDER_ABI,
            chainInfo.chain,
            chainInfo.chainEnv
        );

        const [reservesData, baseCurrencyInfo] =
            await uiPoolDataProviderContract.getReservesData(
                chainInfo.addresses.poolAddressesProvider
            );
        /*
        const reservesData = await this.batchEthCall(
            aaveChainInfo.addresses.pool,
            null,
            this.aavePoolContractAbi,
            "getReservesData",
            chainInfo.chain,
            chainInfo.chainEnv
        );
*/
        console.log(reservesData);
        /*
        const result1 = await this.getHealthFactorAndConfigurationForAddresses(
            [
                "0x00000000000b189d484abb06a0eb5ed0fb3e9db2",
                "0x00000001fd5f90b69bc5d650985ea1bfe5fea7ac",
            ],
            chain,
            chainEnv
        );

        const prices = await this.batchEthCall(
            aaveChainInfo.aaveOracleAddress,
            reserves,
            this.aaveOracleAbi,
            "getAssetsPrices",
            chain,
            chainEnv
        );

        console.log(prices);
*/
        return;

        const queryParams = {
            chain: key,
        };
        const _dbAddresses = await sqlManager.execQuery(
            `SELECT * FROM addresses 
            where chain = @chain AND userconfiguration IS NOT NULL AND healthfactor < 2 
            ORDER BY healthfactor
            OFFSET 2000 ROWS FETCH NEXT 1 ROWS ONLY;`,
            queryParams
        );

        //test - retrieve user configuration from chain
        const dbAddressesHFandConfig =
            await this.getHealthFactorAndConfigurationForAddresses(
                _.map(_dbAddresses, (a: any) => a.address),
                chain,
                chainEnv
            );
        const dbAddresses = _.map(dbAddressesHFandConfig, (o) => {
            return {
                address: o.address,
                userconfiguration: o.userConfiguration,
            };
        });

        let reservesAddresses = Object.keys(aaveChainInfo.reserves);
        let usersReserves: any = {};
        for (let j = 0; j < dbAddresses.length; j++) {
            const address = dbAddresses[j].address;
            let userConfiguration = dbAddresses[j].userconfiguration;
            let i = userConfiguration.length - 1;
            let userReserves: string[] = [];
            //loop through reserves
            for (let reserve of reservesAddresses) {
                if (
                    (i >= 0 && userConfiguration[i] == "1") ||
                    (i > 0 && userConfiguration[i - 1] == "1")
                ) {
                    userReserves.push(reserve);
                }
                i = i - 2;
                if (i <= 0) break;
            }
            if (userReserves.length > 0) {
                usersReserves[address] = userReserves;
            }
        }

        const userReservesAddresses = Object.keys(usersReserves);
        let balanceOfTokenAddresses: string[] = [];
        let balanceOfUserAddresses: string[] = [];
        for (let i = 0; i < userReservesAddresses.length; i++) {
            const address = userReservesAddresses[i];
            const reserves = usersReserves[address];
            for (let j = 0; j < reserves.length; j++) {
                const reserve = reserves[j];
                balanceOfTokenAddresses.push(reserve);
                balanceOfUserAddresses.push(address);
            }
        }

        const result = await this.batchEthCall(
            balanceOfTokenAddresses,
            balanceOfUserAddresses,
            Constants.TOKEN_ABI,
            "balanceOf",
            chain,
            chainEnv
        );

        console.log(balanceOfTokenAddresses, result);
    }

    async getBalanceOf(
        address: string,
        tokenAddress: string,
        chain: string,
        chainEnv: string = "mainnet"
    ) {
        await this.initializeAlchemy();
        const balance = await this.batchEthCall(
            tokenAddress,
            address,
            Constants.TOKEN_ABI,
            "balanceOf",
            chain,
            chainEnv
        );
        return balance.toString();
    }

    async testFunction(context: InvocationContext) {
        logger.initialize(
            "function:testFunction",
            LoggingFramework.ApplicationInsights,
            context
        );
        await logger.log("Start testFunction");
        await common.sleep(1000);
        await logger.log("End testFunction");
    }

    //#endregion test

    /**
     * TODO Decide which asset pair to liquidate for a given user
     *
     * @param address
     * @param assets is an object with two arrays: collateral and debt
     * @returns Array of asset pair to liquidate [collateralAsset, debtAsset]
     */
    async decideWhichAssetPairToLiquidate(address: any, assets: any) {
        //TODO how to decide which asset pair to liquidate?

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

    //#endregion healthFactor check loop

    parseReserveConfiguration(data: any) {
        const bnData = new Big(data);

        // Constants for bit positions and lengths
        const LTV_BITS = { start: 0, length: 16 };
        const LIQ_THRESHOLD_BITS = { start: 16, length: 16 };
        const LIQ_BONUS_BITS = { start: 32, length: 16 };
        const DECIMALS_BITS = { start: 48, length: 8 };
        const ACTIVE_BIT = 56;
        const FROZEN_BIT = 57;
        const BORROWING_ENABLED_BIT = 58;
        const STABLE_BORROWING_ENABLED_BIT = 59;
        const PAUSED_BIT = 60;
        const ISOLATION_MODE_BIT = 61;
        const SILOED_BORROWING_BIT = 62;
        const FLASHLOAN_ENABLED_BIT = 63;
        const RESERVE_FACTOR_BITS = { start: 64, length: 16 };
        const BORROW_CAP_BITS = { start: 80, length: 36 };
        const SUPPLY_CAP_BITS = { start: 116, length: 36 };
        const LIQ_PROTOCOL_FEE_BITS = { start: 152, length: 16 };
        const EMODE_CATEGORY_BITS = { start: 168, length: 8 };
        const UNBACKED_MINT_CAP_BITS = { start: 176, length: 36 };
        const DEBT_CEILING_BITS = { start: 212, length: 40 };
        const VIRTUAL_ACCOUNTING_BIT = 252;

        // Helper function to extract bits
        const extractBits = (data: any, start: any, length: any) => {
            return parseInt(
                bnData.div(Big(2).pow(start)).mod(Big(2).pow(length)).toFixed(0)
            );
        };

        // Extract properties using bitwise operations
        const ltv = extractBits(bnData, LTV_BITS.start, LTV_BITS.length);
        const liquidationThreshold = extractBits(
            bnData,
            LIQ_THRESHOLD_BITS.start,
            LIQ_THRESHOLD_BITS.length
        );
        const liquidationBonus = extractBits(
            bnData,
            LIQ_BONUS_BITS.start,
            LIQ_BONUS_BITS.length
        );
        const decimals = extractBits(
            bnData,
            DECIMALS_BITS.start,
            DECIMALS_BITS.length
        );
        const isActive = bnData.div(Big(2).pow(ACTIVE_BIT)).mod(2).eq(1);
        const isFrozen = bnData.div(Big(2).pow(FROZEN_BIT)).mod(2).eq(1);
        const isBorrowingEnabled = bnData
            .div(Big(2).pow(BORROWING_ENABLED_BIT))
            .mod(2)
            .eq(1);
        const isStableBorrowingEnabled = bnData
            .div(Big(2).pow(STABLE_BORROWING_ENABLED_BIT))
            .mod(2)
            .eq(1);
        const isPaused = bnData.div(Big(2).pow(PAUSED_BIT)).mod(2).eq(1);
        const isIsolationModeEnabled = bnData
            .div(Big(2).pow(ISOLATION_MODE_BIT))
            .mod(2)
            .eq(1);
        const isSiloedBorrowingEnabled = bnData
            .div(Big(2).pow(SILOED_BORROWING_BIT))
            .mod(2)
            .eq(1);
        const isFlashloanEnabled = bnData
            .div(Big(2).pow(FLASHLOAN_ENABLED_BIT))
            .mod(2)
            .eq(1);
        const reserveFactor = extractBits(
            bnData,
            RESERVE_FACTOR_BITS.start,
            RESERVE_FACTOR_BITS.length
        );
        const borrowCap = extractBits(
            bnData,
            BORROW_CAP_BITS.start,
            BORROW_CAP_BITS.length
        );
        const supplyCap = extractBits(
            bnData,
            SUPPLY_CAP_BITS.start,
            SUPPLY_CAP_BITS.length
        );
        const liqProtocolFee = extractBits(
            bnData,
            LIQ_PROTOCOL_FEE_BITS.start,
            LIQ_PROTOCOL_FEE_BITS.length
        );
        const eModeCategory = extractBits(
            bnData,
            EMODE_CATEGORY_BITS.start,
            EMODE_CATEGORY_BITS.length
        );
        const unbackedMintCap = extractBits(
            bnData,
            UNBACKED_MINT_CAP_BITS.start,
            UNBACKED_MINT_CAP_BITS.length
        );
        const debtCeiling = extractBits(
            bnData,
            DEBT_CEILING_BITS.start,
            DEBT_CEILING_BITS.length
        );
        const isVirtualAccountingEnabled = bnData
            .div(Big(2).pow(VIRTUAL_ACCOUNTING_BIT))
            .mod(2)
            .eq(1);

        return {
            ltv,
            liquidationThreshold,
            liquidationBonus,
            decimals,
            isActive,
            isFrozen,
            isBorrowingEnabled,
            isStableBorrowingEnabled,
            isPaused,
            isIsolationModeEnabled,
            isSiloedBorrowingEnabled,
            isFlashloanEnabled,
            reserveFactor,
            borrowCap,
            supplyCap,
            liqProtocolFee,
            eModeCategory,
            unbackedMintCap,
            debtCeiling,
            isVirtualAccountingEnabled,
        };
    }
}

export default HealthFactorCheckEngine.getInstance();
