import common from "../common/common";
import _ from "lodash";
import encryption from "../common/encryption";
import sqlManager from "../managers/sqlManager";
import { ethers, formatUnits } from "ethers";
import Big from "big.js";

class HealthFactorCheckEngine {
    //#region TODO remove or change them when ready to go live
    liquidationEnabled: boolean = false;
    forceLiquidationWorkflow: boolean = true;
    //#endregion

    private static instance: HealthFactorCheckEngine;
    private constructor() {}

    public static getInstance(): HealthFactorCheckEngine {
        if (!HealthFactorCheckEngine.instance) {
            HealthFactorCheckEngine.instance = new HealthFactorCheckEngine();
        }
        return HealthFactorCheckEngine.instance;
    }

    //#region Initialization

    async initializeHealthFactorEngine() {
        if (this.aave) return;
        this.aave = {};

        const privateKey = await encryption.getAndDecryptSecretFromKeyVault(
            "PRIVATEKEYENCRYPTED"
        );
        const alchemyKey = await encryption.getAndDecryptSecretFromKeyVault(
            "ALCHEMYKEYENCRYPTED"
        );

        const aaveChainsInfos = await common.getAaveChainsInfos();

        for (const aaveChainInfo of aaveChainsInfos) {
            const key = `${aaveChainInfo.chain}-${aaveChainInfo.chainEnv}`;
            this.aave[key] = await this.setAaveChainInfo(
                privateKey,
                alchemyKey,
                aaveChainInfo
            );
        }
    }

    async setAaveChainInfo(
        privateKey: string,
        alchemyKey: string,
        aaveChainInfo: any
    ) {
        const alchemyUrl = `https://${aaveChainInfo.chain}-${aaveChainInfo.chainEnv}.g.alchemy.com/v2/${alchemyKey}`;
        const provider = new ethers.JsonRpcProvider(alchemyUrl);
        const signer = new ethers.Wallet(privateKey, provider);

        const aaveLendingPoolContract = new ethers.Contract(
            aaveChainInfo.lendingPoolAddress,
            this.aaveLendingPoolContractAbi,
            signer
        );

        const aaveAddressesProviderContract = new ethers.Contract(
            aaveChainInfo.addressesProviderAddress,
            this.aaveAddressesProviderContractAbi,
            provider
        );

        const aavePriceOracleAddress =
            await aaveAddressesProviderContract.getPriceOracle();

        const aavePriceOracleContract = new ethers.Contract(
            aavePriceOracleAddress,
            this.aavePriceOracleAbi,
            provider
        );

        const reserves = await aaveLendingPoolContract.getReservesList();
        let tokenContracts: any = {};
        let tokenDecimals: any = {};
        for (const reserve of reserves) {
            const tokenContract = new ethers.Contract(
                reserve,
                this.aaveTokenAbi,
                provider
            );
            tokenContracts[reserve] = tokenContract;

            const decimals = await tokenContract.decimals();
            tokenDecimals[reserve] = decimals;
        }

        return _.assign(aaveChainInfo, {
            alchemyUrl: alchemyUrl,
            provider: provider,
            signer: signer,
            aaveLendingPoolContract: aaveLendingPoolContract,
            aaveAddressesProviderContract: aaveAddressesProviderContract,
            aavePriceOracleContract: aavePriceOracleContract,
            tokenContracts: tokenContracts,
            tokenDecimals: tokenDecimals,
            reserves: Array.from(reserves),
        });
    }

    //#endregion Initialization

    //#region Variables

    aave: any;
    oldReservesPrices: any;

    aaveLendingPoolContractAbi = [
        "function getUserAccountData(address user) view returns (uint256 totalCollateralETH, uint256 totalDebtETH, uint256 availableBorrowsETH, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
        "function getUserEMode(address user) external view returns (uint256)",
        "function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken) external returns (uint256, uint256, uint256)",
        "function getReservesList() external view returns (address[] memory)",
        "function getReserveData(address asset) external view returns (uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, uint40 liquidationGracePeriodUntil, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt, uint128 virtualUnderlyingBalance)",
        "function getUserConfiguration(address user) external view returns (uint256 configuration)",
    ];

    aaveAddressesProviderContractAbi = [
        "function getPriceOracle() external view returns (address)",
    ];

    aavePriceOracleAbi = [
        "function getAssetsPrices(address[] calldata assets) external view returns (uint256[] memory)",
    ];

    aaveTokenAbi = [
        "function balanceOf(address) view returns (uint256)",
        "function decimals() external view returns (uint8)",
    ];

    //#endregion Variables

    //#region Helper methods

    getAaveChainInfo(chain: string, chainEnv: string = "mainnet") {
        const key = `${chain}-${chainEnv}`;
        return this.aave[key];
    }

    getHealthFactorFromUserAccountData(userAccountData: any) {
        const healthFactorStr = formatUnits(userAccountData[5], 18);
        return parseFloat(healthFactorStr);
    }

    //#endregion Helper methods

    //#region healthFactor DB check loop

    /**
     * This method is used to periodically check the health factor and userConfiguration of the addresses that are stored in the DB,
     * so that the data in the DB is always up to date, up to the interval of the cron job that calls this method.
     * The method does NOT contains an infinite loop. It is meant to be scheduled by a cron job or similar.
     *
     * TODO: schedule this method to run every hour or so on azure
     * TODO: check Compute Units utilization of method batchEthCallForAddresses if there are many addresses, evtl split call in smaller chunks
     */
    async periodicalAccountsHealthFactorAndConfigurationCheck() {
        const aaveChainsInfos = await common.getAaveChainsInfos();
        await this.initializeHealthFactorEngine();
        for (const info of aaveChainsInfos) {
            const aaveLendingPoolContractAddress = await this.getAaveChainInfo(
                info.chain,
                info.chainEnv
            ).aaveLendingPoolContract.target;
            const dbAddressesArr = await sqlManager.execQuery(
                `SELECT * FROM addresses where chain = '${info.chain}-${info.chainEnv}';`
            );
            const _addresses = _.map(dbAddressesArr, (a: any) => a.address);
            let contractAddressArray = [];
            for (let i = 0; i < _addresses.length; i++) {
                contractAddressArray.push(aaveLendingPoolContractAddress);
            }

            const userAccountData = await this.batchEthCallForAddresses(
                contractAddressArray,
                _addresses,
                this.aaveLendingPoolContractAbi,
                "getUserAccountData",
                info.chain,
                info.chainEnv
            );

            const userConfiguration = await this.batchEthCallForAddresses(
                contractAddressArray,
                _addresses,
                this.aaveLendingPoolContractAbi,
                "getUserConfiguration",
                info.chain,
                info.chainEnv
            );

            let query = "";
            for (let i = 0; i < _addresses.length; i++) {
                const address = _addresses[i];
                const healthFactor = this.getHealthFactorFromUserAccountData(
                    userAccountData[i]
                );
                const userConfigurationBinary = common.intToBinary(
                    parseInt(userConfiguration[i])
                );

                if (healthFactor > 5) {
                    query += `DELETE FROM addresses WHERE address = '${address}' AND chain = '${info.chain}-${info.chainEnv}';`;
                } else {
                    query += `UPDATE addresses SET healthfactor = ${healthFactor}, userconfiguration = '${userConfigurationBinary}' WHERE address = '${address}' AND chain = '${info.chain}-${info.chainEnv}';`;
                }
            }

            if (query) await sqlManager.execQuery(query);
        }
    }

    //#endregion healthFactor DB check loop

    /**
     * This method is used currently from webhookEngine.ts to get the health factor and user configuration for a given address
     *
     * @param address
     * @param chain
     * @param chainEnv
     * @returns
     */
    async getUserHealthFactorAndConfiguration(
        address: string,
        chain: string,
        chainEnv: string = "mainnet"
    ) {
        await this.initializeHealthFactorEngine();
        let aaveLendingPoolContract = this.getAaveChainInfo(
            chain,
            chainEnv
        ).aaveLendingPoolContract;
        const userAccountData =
            await aaveLendingPoolContract.getUserAccountData(address);

        const healthFactor =
            this.getHealthFactorFromUserAccountData(userAccountData);
        const userConfiguration =
            await aaveLendingPoolContract.getUserConfiguration(address);

        const userConfigurationBinary = common.intToBinary(
            parseInt(userConfiguration)
        );
        return {
            healthFactor: healthFactor,
            userConfiguration: userConfigurationBinary,
        };
    }

    /**
     *  Check the health factor for the addresses that have the reserves whose prices have changed, either as collateral or as debt
     *  and liquidate them if their health factor is below 1. The method contains an infinite loop that checks the reserves prices
     *  every n seconds and if the prices have changed, it checks the health factor for the addresses that have the changed reserves
     *
     * //TODO check Compute Units utilization of method batchEthCallForAddresses if there are many addresses, evtl split call in smaller chunks
     * //TODO implement logic to decide which asset pair to liquidate for a given user
     * //TODO connect to smart contract for liquidation process
     *
     * @param chain
     * @param chainEnv
     */
    async checkReservesPrices(chain: string, chainEnv: string = "mainnet") {
        //#region initialization

        await this.initializeHealthFactorEngine();
        const aaveChainInfo: any = this.getAaveChainInfo(chain, chainEnv);
        const reserves = aaveChainInfo.reserves;

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

        while (true) {
            //get the prices for the reserves of the lending protocol
            const prices =
                await aaveChainInfo.aavePriceOracleContract.getAssetsPrices(
                    reserves
                );

            let newReservesPrices: any = {};
            for (let i = 0; i < reserves.length; i++) {
                const reserveAddress = reserves[i];
                const price = prices[i];
                newReservesPrices[reserveAddress] = price;
            }

            //by default we should not perform the check. If price changes are found, we do check
            let shouldPerformCheck = false;

            //if it is the first time we check the prices, we store the current prices as old prices
            if (!this.oldReservesPrices)
                this.oldReservesPrices = newReservesPrices;
            else {
                //check if the prices have changed for the reserves
                let reservesChangedCheck: any[] = [];
                for (const reserveAddress of reserves) {
                    const oldPrice = this.oldReservesPrices[reserveAddress];
                    const newPrice = newReservesPrices[reserveAddress];
                    const decimals =
                        aaveChainInfo.tokenDecimals[reserveAddress];
                    const normalizedChange = new Big(newPrice - oldPrice).div(
                        new Big(10).pow(
                            new Big(18).minus(new Big(decimals)).toNumber()
                        )
                    );

                    let check = "none";

                    //if the normalized change is greater than the given treshold, we should perform the check
                    if (normalizedChange.abs().gte(new Big(0.0005))) {
                        console.log(
                            `Price change for reserve ${reserveAddress} is ${normalizedChange.toNumber()}`
                        );

                        //if we come here, it means there is at least 1 changed reserve. We should perform the check
                        //later on all accounts that have the changed reserves either as collateral or as debt
                        //depending if price has gone up or down
                        shouldPerformCheck = true;

                        //add current reserve to the list of changed reserves and check if it should be checked as collateral or a debt
                        check =
                            normalizedChange.toNumber() < 0
                                ? "collateral"
                                : "debt";

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

                    //define object (map) of user assets that have the changed reserves either as collateral or as debt
                    //userAssets: {address: {collateral: [reserves], debt: [reserves]}}
                    let userAssets: any = {};

                    //loop through loaded addresses from DB
                    for (const addressRecord of addressesDb) {
                        //get user configuration in string format e.g. 100010001100 (it's stored in DB as a string)
                        const userConfiguration =
                            addressRecord.userconfiguration;

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
                                        userAssets[addressRecord.address].debt =
                                            [];

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
                                    ].collateral.push(
                                        reserveChangedCheck.reserve
                                    );
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

                        const aaveLendingPoolContractAddress =
                            await this.getAaveChainInfo(
                                aaveChainInfo.chain,
                                aaveChainInfo.chainEnv
                            ).aaveLendingPoolContract.target;

                        let contractAddressArray = [];
                        for (let i = 0; i < addressesToCheck.length; i++) {
                            contractAddressArray.push(
                                aaveLendingPoolContractAddress
                            );
                        }

                        //#endregion

                        //batch call the health factor for the addresses
                        const userAccountData =
                            await this.batchEthCallForAddresses(
                                contractAddressArray,
                                addressesToCheck,
                                this.aaveLendingPoolContractAbi,
                                "getUserAccountData",
                                aaveChainInfo.chain,
                                aaveChainInfo.chainEnv
                            );

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
                                console.log(
                                    "User " +
                                        address +
                                        " has health factor below 1: HF = " +
                                        healthFactor
                                );

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
                            console.log("Found Addresses to liquidate:");
                            console.log(addressesToLiquidate);
                        }
                    }
                }
            }

            //wait 3 seconds before checking again
            await common.sleep(3000);
        }

        //#endregion infinite loop
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
    async batchEthCallForAddresses(
        contractsAddresses: string[],
        methodParams: string[] | null,
        contractAbi: any,
        methodName: string,
        chain: string,
        chainEnv: string = "mainnet"
    ) {
        await this.initializeHealthFactorEngine();

        if (methodParams && contractsAddresses.length != methodParams.length)
            throw new Error(
                "contractsAddresses and methodParams length mismatch"
            );

        const contractInterface = new ethers.Interface(contractAbi);
        const batchRequests = contractsAddresses.map(
            (contractAddress, index) => ({
                jsonrpc: "2.0",
                method: "eth_call",
                params: [
                    {
                        to: contractAddress,
                        data: methodParams
                            ? contractInterface.encodeFunctionData(methodName, [
                                  methodParams[index],
                              ])
                            : contractInterface.encodeFunctionData(methodName),
                    },
                    "latest",
                ],
                id: index,
            })
        );

        try {
            const alchemyUrl = this.getAaveChainInfo(
                chain,
                chainEnv
            ).alchemyUrl;
            const response = await fetch(alchemyUrl, {
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

            return decodedResults;
        } catch (error) {
            console.error("Error batch calling " + methodName, error);
            return null;
        }
    }

    async testJob() {
        console.log("test successful");
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

        const userCollateralAssets = assets.collateral;
        const userDebtAssets = assets.debt;

        /*
        // Iterate through each reserve and get user data
        for (const reserve of reservesList) {
            const reserveData = await this.lendingPoolContract.getReserveData(
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
}

export default HealthFactorCheckEngine.getInstance();
