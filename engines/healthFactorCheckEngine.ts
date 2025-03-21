import common from "../common/common";
import _, { forEach } from "lodash";
import encryption from "../common/encryption";
import fileUtilities from "../common/fileUtilities";
import sqlManager from "../managers/sqlManager";
import { ethers, formatUnits } from "ethers";
import { ChainedTokenCredential } from "@azure/identity";
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

        this.aaveLendingPoolInterface = new ethers.Interface(
            this.aaveLendingPoolContractAbi
        );
    }

    //#region Variables

    aave: any;
    aaveLendingPoolInterface: any;
    balanceOfAbi = ["function balanceOf(address) view returns (uint256)"];
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

    // Aave Oracle ABI (just the function we need)
    aavePriceOracleAbi = [
        "function getSourceOfAsset(address asset) external view returns (address)",
        "function getAssetsPrices(address[] calldata assets) external view returns (uint256[] memory)",
    ];

    aaveReserveOracleAbi = [
        "function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
        "function latestAnswer() external view returns (int256)",
    ];

    //#endregion Variables

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

        const aggregatorInterface = new ethers.Interface([
            "function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
        ]);
        const reserves = await aaveLendingPoolContract.getReservesList();
        //let reserveOracles: any = {};
        let tokenContracts: any = {};
        let tokenDecimals: any = {};
        for (const reserve of reserves) {
            const tokenAbi = [
                "function decimals() external view returns (uint8)",
            ];
            const tokenContract = new ethers.Contract(
                reserve,
                tokenAbi,
                provider
            );
            tokenContracts[reserve] = tokenContract;

            const decimals = await tokenContract.decimals();
            tokenDecimals[reserve] = decimals;

            /*
            const oracleAddress =
                await aavePriceOracleContract.getSourceOfAsset(reserve);
            reserveOracles[reserve] = new ethers.Contract(
                oracleAddress,
                aggregatorInterface,
                provider
            );
            */
        }

        return _.assign(aaveChainInfo, {
            alchemyUrl: alchemyUrl,
            provider: provider,
            signer: signer,
            aaveLendingPoolContract: aaveLendingPoolContract,
            aaveAddressesProviderContract: aaveAddressesProviderContract,
            aavePriceOracleContract: aavePriceOracleContract,
            //reserveOraclesContracts: reserveOracles,
            tokenContracts: tokenContracts,
            tokenDecimals: tokenDecimals,
            reserves: Array.from(reserves),
        });
    }

    getAaveChainInfo(chain: string, chainEnv: string = "mainnet") {
        const key = `${chain}-${chainEnv}`;
        return this.aave[key];
    }

    getHealthFactorFromUserAccountData(userAccountData: any) {
        const healthFactorStr = formatUnits(userAccountData[5], 18);
        return parseFloat(healthFactorStr);
    }

    async periodicalAccountsHealthFactorAndConfigurationCheck() {
        const aaveChainsInfos = await common.getAaveChainsInfos();
        await this.initializeHealthFactorEngine();
        for (const info of aaveChainsInfos) {
            //mirko
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

    async getHealthFactor(chain: string, chainEnv: string, address: string) {
        await this.initializeHealthFactorEngine();
        let aaveLendingPoolContract = this.getAaveChainInfo(
            chain,
            chainEnv
        ).aaveLendingPoolContract;
        const userAccountData =
            await aaveLendingPoolContract.getUserAccountData(address);
        return this.getHealthFactorFromUserAccountData(userAccountData);
    }

    async checkReservesPrices(chain: string, chainEnv: string = "mainnet") {
        await this.initializeHealthFactorEngine();
        const aaveChainInfo: any = this.getAaveChainInfo(chain, chainEnv);
        const addressesDb = await sqlManager.execQuery(
            `SELECT * FROM addresses where chain = '${aaveChainInfo.chain}-${aaveChainInfo.chainEnv}' AND healthfactor < 2;`
        );
        const reserves = aaveChainInfo.reserves;
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

        let shouldPerformCheck = false;
        if (!this.oldReservesPrices) this.oldReservesPrices = newReservesPrices;
        else {
            let reservesChangedCheck: any[] = [];
            for (const reserveAddress of reserves) {
                const oldPrice = this.oldReservesPrices[reserveAddress];
                const newPrice = newReservesPrices[reserveAddress];
                const decimals = aaveChainInfo.tokenDecimals[reserveAddress];
                const normalizedChange = new Big(newPrice - oldPrice).div(
                    new Big(10).pow(
                        new Big(18).minus(new Big(decimals)).toNumber()
                    )
                );

                let check = "none";
                if (normalizedChange.abs().gte(new Big(0.0005))) {
                    console.log(
                        `Price change for reserve ${reserveAddress} is ${normalizedChange.toNumber()}`
                    );

                    shouldPerformCheck = true;
                    //add current reserve to the list of changed reserves
                    check =
                        normalizedChange.toNumber() < 0 ? "collateral" : "debt";

                    //update the old price of the current reserve to the changed price, so that we base our next change detection
                    //on this current price and not the old one
                    this.oldReservesPrices[reserveAddress] = newPrice;
                }

                reservesChangedCheck.push({
                    reserve: reserveAddress,
                    check: check,
                });
            }

            //filter the addresses from the DB that have the changed reserves either as collateral or as debt
            if (shouldPerformCheck) {
                const addressesDb = await sqlManager.execQuery(
                    `SELECT * FROM addresses where chain = '${aaveChainInfo.chain}-${aaveChainInfo.chainEnv}' AND healthfactor < 2;`
                );
                let userAssets: any = [];
                let addressesToCheck: any = [];
                for (const addressRecord of addressesDb) {
                    const userConfiguration = addressRecord.userconfiguration;

                    let i = userConfiguration.length - 1;
                    for (let reserveChangedCheck of reservesChangedCheck) {
                        if (reserveChangedCheck.check != "none") {
                            if (
                                userConfiguration[i] == "1" &&
                                reserveChangedCheck.check == "debt"
                            ) {
                                addressesToCheck.push(
                                    reserveChangedCheck.reserve
                                );

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
                                addressesToCheck.push(
                                    reserveChangedCheck.reserve
                                );

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

                if (addressesToCheck.length > 0) {
                    //check the health factor for the addresses that have the changed reserves either as collateral or as debt
                    //mirko
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

                    const userAccountData = await this.batchEthCallForAddresses(
                        contractAddressArray,
                        addressesToCheck,
                        this.aaveLendingPoolContractAbi,
                        "getUserAccountData",
                        aaveChainInfo.chain,
                        aaveChainInfo.chainEnv
                    );

                    let addressesToLiquidate: any[] = [];

                    for (let i = 0; i < addressesToCheck.length; i++) {
                        const address = addressesToCheck[i];
                        const healthFactor =
                            this.getHealthFactorFromUserAccountData(
                                userAccountData[i]
                            );

                        if (healthFactor < 1) {
                            console.log(
                                "User " +
                                    address +
                                    " has health factor below 1: HF = " +
                                    healthFactor
                            );

                            const assetsToLiquidate: string[] =
                                await this.decideWhichAssetPairToLiquidate(
                                    address,
                                    userAssets[address]
                                );

                            addressesToLiquidate.push({
                                address: address,
                                assets: assetsToLiquidate, //TODO get addresses pair to liquidate
                            });
                        }
                    }

                    if (addressesToLiquidate.length > 0) {
                        //TODO MIRKO liquidate the addresses

                        console.log(addressesToLiquidate);
                    }
                }
            }
        }
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

    async test() {
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
                this.balanceOfAbi,
                this.signer
            );
            const stableDebtTokenContract = new ethers.Contract(
                reserveData.stableDebtTokenAddress,
                this.balanceOfAbi,
                this.signer
            );
            const variableDebtTokenContract = new ethers.Contract(
                reserveData.variableDebtTokenAddress,
                this.balanceOfAbi,
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
