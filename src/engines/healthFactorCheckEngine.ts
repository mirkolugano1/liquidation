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
import { pool } from "mssql";

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
                "No reserves found in DB. Please run the updateReservesData function first.",
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

            const addresses = await this.multicall(
                aaveChainInfo.addresses.poolAddressesProvider,
                null,
                "ADDRESSES_PROVIDER_ABI",
                ["getPoolDataProvider", "getPriceOracle", "getPool"],
                aaveChainInfo.chain,
                aaveChainInfo.chainEnv
            );

            if (!addresses) {
                await logger.log(
                    `No addresses found for chain ${aaveChainInfo.chain} and env ${aaveChainInfo.chainEnv}`,
                    "functionAppExecution"
                );
                return;
            }

            chainInfo.addresses.poolDataProvider = addresses[0]?.toString();
            chainInfo.addresses.aaveOracle = addresses[1]?.toString();
            chainInfo.addresses.pool = addresses[2]?.toString();
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
     * Periodically update the reserves data in the DB
     * so that we don't need to fetch it from the blockchain every time
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

        for (const chainInfo of Constants.AAVE_CHAINS_INFOS) {
            const key = `${chainInfo.chain}-${chainInfo.chainEnv}`;
            const aaveChainInfo = this.getAaveChainInfo(
                chainInfo.chain,
                chainInfo.chainEnv
            );

            //get current list of reserves from the chain
            const poolDataProviderContract = this.getContract(
                aaveChainInfo.addresses.poolDataProvider,
                Constants.ABIS.POOL_DATA_PROVIDER_ABI,
                chainInfo.chain,
                chainInfo.chainEnv
            );

            const results = await this.multicall(
                chainInfo.addresses.poolDataProvider,
                null,
                "POOL_DATA_PROVIDER_ABI",
                ["getAllReservesTokens", "getAllATokens"],
                chainInfo.chain,
                chainInfo.chainEnv
            );

            const allReserveTokens: any[] = _.map(results[0][0], (o) => {
                return {
                    chain: key,
                    symbol: o[0].toString(),
                    address: o[1].toString(),
                };
            });
            const aTokens = results[1][0];
            for (let i = 0; i < aTokens.length; i++) {
                allReserveTokens[i].atokenaddress = aTokens[i][1].toString();
            }

            const allReserveTokensAddresses = _.map(
                allReserveTokens,
                (o) => o.address
            );

            const reservesData1 = await this.multicall(
                aaveChainInfo.addresses.poolDataProvider,
                allReserveTokensAddresses,
                "POOL_DATA_PROVIDER_ABI",
                "getReserveData",
                chainInfo.chain,
                chainInfo.chainEnv
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
                aaveChainInfo.addresses.poolDataProvider,
                allReserveTokensAddresses,
                "POOL_DATA_PROVIDER_ABI",
                "getReserveConfigurationData",
                chainInfo.chain,
                chainInfo.chainEnv
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
                aaveChainInfo.reserves,
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
                )}') AND chain = '${key}';`;
                await sqlManager.execQuery(sqlQuery);
            }

            //prepare query to update reserves list in DB
            //and update DB
            let reservesSQLList: string[] = _.map(allReserveTokens, (o) => {
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
                }', '${o.lastupdatetimestamp}', '${o.atokenaddress}', '${
                    o.totalstabledebt
                }', '${o.totalvariabledebt}', '${o.ltv}')`;
            });

            if (reservesSQLList.length > 0) {
                const sqlQuery = `
                    MERGE INTO reserves AS target
                    USING (VALUES 
                        ${reservesSQLList.join(",")}
                    ) AS source (address, chain, symbol, decimals, reserveliquidationtreshold, reserveliquidationbonus, reservefactor, usageascollateralenabled, borrowingenabled, stableborrowrateenabled, isactive, isfrozen, liquidityindex, variableborrowindex, liquidityrate, variableborrowrate, lastupdatetimestamp, atokenaddress, totalstabledebt, totalvariabledebt, ltv)
                    ON (target.address = source.address AND target.chain = source.chain)
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
                        totalstabledebt = source.totalstabledebt,
                        totalvariabledebt = source.totalvariabledebt,
                        ltv = source.ltv
                    WHEN NOT MATCHED BY TARGET THEN
                        INSERT (address, chain, symbol, decimals, reserveliquidationtreshold, reserveliquidationbonus, reservefactor, usageascollateralenabled, borrowingenabled, stableborrowrateenabled, isactive, isfrozen, liquidityindex, variableborrowindex, liquidityrate, variableborrowrate, lastupdatetimestamp, atokenaddress, totalstabledebt, totalvariabledebt, ltv)
                        VALUES (source.address, source.chain, source.symbol, source.decimals, source.reserveliquidationtreshold, source.reserveliquidationbonus, source.reservefactor, source.usageascollateralenabled, source.borrowingenabled, source.stableborrowrateenabled, source.isactive, source.isfrozen, source.liquidityindex, source.variableborrowindex, source.liquidityrate, source.variableborrowrate, source.lastupdatetimestamp, source.atokenaddress, source.totalstabledebt, source.totalvariabledebt, source.ltv);
                `;

                //console.log(sqlQuery);
                await sqlManager.execQuery(sqlQuery);
            }
        }

        await logger.log("Ended updateReservesData", "functionAppExecution");
    }

    //#region TEST CODE (NOT YET READY)

    async getHealthFactorAndConfigurationForAddresses(
        _addresses: string[],
        chain: string,
        chainEnv: string = "mainnet"
    ) {
        if (!_addresses || _addresses.length == 0) return [];

        let results: any[] = [];

        const chainInfo = await this.getAaveChainInfo(chain, chainEnv);

        const userAccountData = await this.multicall(
            chainInfo.addresses.pool,
            _addresses,
            "POOL_ABI",
            "getUserAccountData",
            chain,
            chainEnv
        );

        const userConfiguration = await this.multicall(
            chainInfo.addresses.pool,
            _addresses,
            "POOL_ABI",
            "getUserConfiguration",
            chain,
            chainEnv
        );

        for (let i = 0; i < _addresses.length; i++) {
            const address = _addresses[i];
            const healthFactor = this.getHealthFactorFromUserAccountData(
                userAccountData[i]
            );
            let userConfigurationInt = parseInt(
                userConfiguration[i].toString()
            );

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
    async updateHealthFactorAndUserConfiguration(
        context: InvocationContext | null = null
    ) {
        //#region initialization

        logger.initialize(
            "function:updateHealthFactorAndUserConfiguration",
            LoggingFramework.ApplicationInsights,
            context
        );

        await logger.log(
            "Start updateHealthFactorAndUserConfiguration",
            "functionAppExecution"
        );

        await this.initializeAlchemy();

        //#endregion initialization

        for (const info of Constants.AAVE_CHAINS_INFOS) {
            const dbAddressesArr = await sqlManager.execQuery(
                `SELECT * FROM addresses where chain = '${info.chain}-${info.chainEnv}';`
            );
            const _addresses = _.map(dbAddressesArr, (a: any) => a.address);
            const addressesChunks = _.chunk(_addresses, 1000);

            for (let i = 0; i < addressesChunks.length; i++) {
                const results =
                    await this.getHealthFactorAndConfigurationForAddresses(
                        addressesChunks[i],
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
                    ELSE healthfactor
                    END,
                    userconfiguration = CASE
                        {1}
                    ELSE userconfiguration
                    END
                WHERE address IN ({2});
            `
                        : "";

                const key = `${info.chain}-${info.chainEnv}`;
                let arr0 = [];
                let arr1 = [];
                let arr2 = [];
                let deleteAddresses: string[] = [];
                for (let i = 0; i < results.length; i++) {
                    if (results[i].healthFactor < 2) {
                        arr0.push(
                            `WHEN address = '${results[i].address}' AND chain = '${key}' THEN ${results[i].healthFactor}`
                        );
                        arr1.push(
                            `WHEN address = '${results[i].address}' AND chain = '${key}' THEN '${results[i].userConfiguration}'`
                        );
                        arr2.push(`'${results[i].address}'`);
                    } else {
                        deleteAddresses.push(results[i].address);
                    }
                }

                query = query.replace("{0}", arr0.join(" "));
                query = query.replace("{1}", arr1.join(" "));
                query = query.replace("{2}", arr2.join(","));

                if (query) await sqlManager.execQuery(query);

                if (deleteAddresses.length > 0) {
                    const sqlQuery = `DELETE FROM addresses WHERE address IN ('${deleteAddresses.join(
                        "','"
                    )}') AND chain = '${key}';`;
                    await sqlManager.execQuery(sqlQuery);
                }
            }
        }

        await logger.log(
            "End updateHealthFactorAndUserConfiguration",
            "functionAppExecution"
        );
    }

    //#endregion healthFactor DB check loop

    /**
     *  Check the health factor for the addresses that have the reserves whose prices have changed, either as collateral or as debt
     *  and liquidate them if their health factor is below 1. The method contains an infinite loop that checks the reserves prices
     *  every n seconds and if the prices have changed, it checks the health factor for the addresses that have the changed reserves
     *
     * //TODO check Compute Units utilization of method multicall if there are many addresses, evtl split call in smaller chunks
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
            Constants.ABIS.AAVE_ORACLE_ABI,
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
                    const userAccountData = await this.multicall(
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

    //#region test

    async doTest(chain: string, chainEnv: string = "mainnet") {
        await this.initializeAlchemy();
        await this.initializeReserves();

        const top = 5;
        const aaveChainInfo = this.getAaveChainInfo(chain, chainEnv);
        const key = `${chain}-${chainEnv}`;
        const _dbAddresses1 = await sqlManager.execQuery(
            `SELECT top 5000 * FROM addresses`
        );

        const _addresses = _.map(_dbAddresses1, (a: any) => a.address);

        let targetAddresses: any[] = [];
        let paramAddresses: any[] = [];
        const reservesAddresses1 = Object.keys(aaveChainInfo.reserves);
        for (let i = 0; i < _addresses.length; i++) {
            const address = _addresses[i];
            for (let j = 0; j < reservesAddresses1.length; j++) {
                const atoken =
                    aaveChainInfo.reserves[reservesAddresses1[j]].atokenaddress;
                targetAddresses.push(atoken);
                paramAddresses.push(address);
            }
        }

        console.log(targetAddresses.length, paramAddresses.length);

        const multicall = await this.multicall(
            targetAddresses,
            paramAddresses,
            "TOKEN_ABI",
            "balanceOf",
            chain,
            chainEnv
        );

        console.log(
            multicall[multicall.length - 1],
            multicall[multicall.length - 2],
            multicall[multicall.length - 3]
        );

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

    async multicallEstimateGas(
        targetAddresses: string | string[],
        paramAddresses: string | string[] | null,
        contractABIsKeys: string | string[],
        methodNames: string | string[],
        chain: string,
        chainEnv: string = "mainnet"
    ) {
        const estimate = await this.multicall(
            targetAddresses,
            paramAddresses,
            contractABIsKeys,
            methodNames,
            chain,
            chainEnv,
            true
        );
        return Number(estimate);
    }

    checkMulticallInputs(
        targetAddresses: string | string[],
        paramAddresses: string | string[] | null,
        contractABIsKeys: string | string[],
        methodNames: string | string[]
    ): [string[], string[], string[], string[]] {
        if (!paramAddresses) paramAddresses = [];

        if (!targetAddresses || targetAddresses.length == 0)
            throw new Error("No targetAddresses provided");

        if (!Array.isArray(targetAddresses))
            targetAddresses = [targetAddresses];

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

        if (!Array.isArray(methodNames)) methodNames = [methodNames];

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

    contractInterfaces: any = {};

    /**
     * Batches multiple calls to a smartContract using the Multicall3 contract.
     *
     * @param targetAddresses the smartContract addresses(es) to call the method on
     * @param paramAddresses the method parameters for each smartContract address
     * @param contractABI the smartContract ABI of the function to be called
     * @param methodName the method name to be called
     * @param chain the chain name (eth, arb, etc)
     * @param chainEnv the chain environment (mainnet, kovan, etc)
     * @returns
     */
    async multicall(
        targetAddresses: string | string[],
        paramAddresses: string | string[] | null,
        contractABIsKeys: string | string[],
        methodNames: string | string[],
        chain: string,
        chainEnv: string = "mainnet",
        estimateGas: boolean = false
    ) {
        [targetAddresses, paramAddresses, contractABIsKeys, methodNames] =
            this.checkMulticallInputs(
                targetAddresses,
                paramAddresses,
                contractABIsKeys,
                methodNames
            );

        const multicallContract = this.getContract(
            Constants.MULTICALL3_ADDRESS,
            Constants.ABIS.MULTICALL3_ABI,
            chain,
            chainEnv
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
                              [paramAddresses[index]]
                          );
                return {
                    target: targetAddress,
                    callData: calldata,
                };
            }
        );

        if (estimateGas) {
            const aaveChainInfo = this.getAaveChainInfo(chain, chainEnv);
            return aaveChainInfo.alchemyProvider.estimateGas(calls);
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
}

export default HealthFactorCheckEngine.getInstance();
