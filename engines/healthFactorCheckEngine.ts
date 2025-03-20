import common from "../common/common";
import _, { forEach } from "lodash";
import encryption from "../common/encryption";
import { CloudStorageManager } from "../managers/cloudStorageManager";
import graphManager from "../managers/graphManager";
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

    cloudStorageManager: CloudStorageManager = new CloudStorageManager();
    addresses: string[] = [];

    private static instance: HealthFactorCheckEngine;
    private constructor() {}

    public static getInstance(): HealthFactorCheckEngine {
        if (!HealthFactorCheckEngine.instance) {
            HealthFactorCheckEngine.instance = new HealthFactorCheckEngine();
        }
        return HealthFactorCheckEngine.instance;
    }

    //#region healthFactor check loop

    aave: any;
    aaveLendingPoolInterface: any;

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
    ];

    aaveReserveOracleAbi = [
        "function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
    ];

    async getReservesOracleContracts(
        chain: string,
        chainEnv: string = "mainnet"
    ) {
        return this.getAaveChainInfo(chain, chainEnv).reserveOraclesContracts;
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

        const aggregatorInterface = new ethers.Interface([
            "function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
        ]);
        const reserves = await aaveLendingPoolContract.getReservesList();
        let reserveOracles: any = {};
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

            const oracleAddress =
                await aavePriceOracleContract.getSourceOfAsset(reserve);
            reserveOracles[reserve] = new ethers.Contract(
                oracleAddress,
                aggregatorInterface,
                provider
            );
        }

        return _.assign(aaveChainInfo, {
            alchemyUrl: alchemyUrl,
            provider: provider,
            signer: signer,
            aaveLendingPoolContract: aaveLendingPoolContract,
            aaveAddressesProviderContract: aaveAddressesProviderContract,
            aavePriceOracleContract: aavePriceOracleContract,
            reserveOraclesContracts: reserveOracles,
            tokenContracts: tokenContracts,
            tokenDecimals: tokenDecimals,
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

    balanceOfAbi = ["function balanceOf(address) view returns (uint256)"];

    async getReservesPrices(chain: string, chainEnv: string = "mainnet") {
        await this.initializeHealthFactorEngine();
        var _reserveOracleContracts: any =
            await this.getReservesOracleContracts(chain, chainEnv);

        //TEST: SIMULATE TOP 1 DUE TO CU LIMITS ON ALCHEMY
        const rok = _.keys(_reserveOracleContracts);
        const reserveOracleContracts = [_reserveOracleContracts[rok[1]]];

        const reserveOracleContractsAddresses = _.map(
            _.values(reserveOracleContracts),
            (c: any) => c.target
        );
        const data = await this.batchEthCallForAddresses(
            reserveOracleContractsAddresses,
            null,
            this.aaveReserveOracleAbi,
            "latestRoundData",
            "arb"
        );

        for (let i = 0; i < data.length; i++) {
            const roundData = data[i];
            const answer = new Big(roundData.answer);
            const reserveAddress = _.keys(
                this.getAaveChainInfo(chain, chainEnv).tokenContracts
            )[i];
            const decimals = this.getAaveChainInfo(chain, chainEnv)
                .tokenDecimals[reserveAddress];

            const divisor = new Big(10).pow(new Big(decimals).toNumber());
            const price = answer.div(divisor).toNumber();

            console.log(`Reserve: ${reserveAddress} - Price: ${price}`);
        }
        console.log(data);
    }

    async getAddressesToCheckHealthFactor() {
        const dbAddressesArr = await sqlManager.execQuery(
            "SELECT * FROM addresses"
        );
        return dbAddressesArr.map((a: any) => a.address);
    }

    reserves: any = {};

    async batchEthCallForAddresses(
        contractsAddresses: string[],
        methodParams: string[] | null,
        contractAbi: any,
        methodName: string,
        chain: string,
        chainEnv: string = "mainnet"
    ) {
        await this.initializeHealthFactorEngine();

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

    async fetchAllUsersReserves(userAddresses: string[]) {
        const ADDRESSES_BATCH_SIZE = 300; // Number of addresses per batch 200
        const RESERVES_BATCH_SIZE = 500; // Number of userReserves per query 500
        let allUserReserves: any = [];

        for (let i = 0; i < userAddresses.length; i += ADDRESSES_BATCH_SIZE) {
            const addressBatch = userAddresses.slice(
                i,
                i + ADDRESSES_BATCH_SIZE
            );
            let skip = 0;
            let hasMore = true;

            while (hasMore) {
                const variables = {
                    addresses: addressBatch,
                    first: RESERVES_BATCH_SIZE,
                    skip: skip,
                };
                const response = await graphManager.execQuery(
                    "userReserves",
                    variables
                );
                const userReserves = response.userReserves;

                allUserReserves = allUserReserves.concat(userReserves);
                skip += RESERVES_BATCH_SIZE;
                hasMore = userReserves.length === RESERVES_BATCH_SIZE;
            }
        }
        return allUserReserves;
    }

    calculateHealthFactor(userReserves: any[]) {
        let totalCollateralInEth = 0n;
        let totalDebtInEth = 0n;

        for (const reserve of userReserves) {
            const {
                currentATokenBalance,
                currentVariableDebt,
                reserve: {
                    decimals,
                    price: { priceInEth },
                    reserveLiquidationThreshold,
                },
            } = reserve;

            const collateralAmount = BigInt(currentATokenBalance);
            const debtAmount = BigInt(currentVariableDebt);
            const price = BigInt(priceInEth);
            const liquidationThreshold = BigInt(reserveLiquidationThreshold);

            if (collateralAmount > 0n && price > 0n) {
                const collateralValueInEth =
                    (collateralAmount * price * liquidationThreshold) /
                    (10000n * 10n ** BigInt(decimals));
                totalCollateralInEth += collateralValueInEth;
            }

            if (debtAmount > 0n && price > 0n) {
                const debtValueInEth =
                    (debtAmount * price) / 10n ** BigInt(decimals);
                totalDebtInEth += debtValueInEth;
            }
        }

        if (totalDebtInEth === 0n) {
            return Infinity;
        }

        return Number(totalCollateralInEth) / Number(totalDebtInEth);
    }

    async fetchUsersReserves(userAddresses: string[]) {
        return await graphManager.execQuery("userReserves", {
            addresses: userAddresses,
            first: 1000,
            skip: 0,
        });
    }

    async test() {
        console.log("test successful");
    }
    /*
    async check() {
        // Retrieve the list of all reserve addresses
        const reservesList = await this.lendingPoolContract.getReservesList();

        //fetch data for each reserve beforehand
        const promises = reservesList.map((reserve: any) =>
            this.lendingPoolContract.getReserveData(reserve.address)
        );
        const results = await Promise.all(promises);
        _.each(reservesList, (reserve: any, index: number) => {
            this.reserves[reserve.address] = results[index];
        });

        //get addresses for which to check health factor
        //presently loaded from txt file. Evtl TODO load from 3rd party monitoring tool?
        let addresses = await this.getAddressesToCheckHealthFactor();

        //addresses = [addresses[18]];

        //check all addresses
        for (let address of addresses) {
            try {
                let userAccountData =
                    await this.lendingPoolContract.getUserAccountData(address);

                const healthFactorStr = formatUnits(userAccountData[5], 18);
                const healthFactor = parseFloat(healthFactorStr);
                if (healthFactor <= 1 || this.forceLiquidationWorkflow) {
                    console.log(
                        `User ${address} has a health factor below threshold: ${healthFactor}`
                    );

                    //get the list of assets the user has (collateral and debt)
                    let userAssets =
                        await this.getUserAssetsFromConfigurationBinary(
                            address,
                            reservesList
                        );

                    //cannot liquidate a user who has no collateral or no debt
                    if (
                        userAssets.collateralAssets.length == 0 ||
                        userAssets.debtAssets.length == 0
                    )
                        continue;

                    //decide which asset pair to liquidate
                    let assetsToLiquidate: any =
                        await this.decideWhichAssetPairToLiquidate(
                            address,
                            userAssets
                        );

                    //Liquidation docs: https://aave.com/docs/developers/smart-contracts/pool#liquidationcall
                    // Liquidate the user's debt
                    if (this.liquidationEnabled) {
                        //TODO call smart contract flashloan + liquidation procedure
                    } else {
                        console.log("liquidation disabled");
                    }
                }
            } catch (error) {
                console.error("Error:", error);
            }
        }
    }
*/
    /**
     *   Example input: 1000000000000000000001001000000000110000
     *   Explanation of userConfiguration
     *   https://aave.com/docs/developers/smart-contracts/pool#view-methods-getuserconfiguration
     */
    /*
    async getUserAssetsFromConfigurationBinary(
        address: string,
        reservesList: string[]
    ) {
        let userConfiguration =
            await this.lendingPoolContract.getUserConfiguration(address);
        let userConfigurationBinary = common.intToBinary(userConfiguration);

        let userAssets: any = {
            collateralAssets: [],
            debtAssets: [],
        };

        let i = userConfigurationBinary.length - 1;
        for (let reserve of reservesList) {
            if (userConfigurationBinary[i] == "1") {
                userAssets.debtAssets.push(reserve);
            }
            if (i > 0 && userConfigurationBinary[i - 1] == "1") {
                userAssets.collateralAssets.push(reserve);
            }
            i = i - 2;
        }

        return userAssets;
    }
*/
    async decideWhichAssetPairToLiquidate(address: any, assets: any) {
        //TODO how to decide which asset pair to liquidate?
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
    }

    async getUserHealthFactor(
        chain: string,
        chainEnv: string,
        address: string,
        decimals: number = 18
    ) {
        await this.initializeHealthFactorEngine();
        const key = `${chain}-${chainEnv}`;
        // Get user account data
        const userAccountData = await this.getAaveChainInfo(
            chain,
            chainEnv
        ).aaveLendingPoolContract.getUserAccountData(address);

        if (userAccountData && userAccountData.length > 5) {
            // Extract health factor
            const healthFactorStr = formatUnits(userAccountData[5], decimals);
            let healthFactor = parseFloat(healthFactorStr);
            if (healthFactor > 99) healthFactor = 99;
            return healthFactor;
        }

        //if we come here, data was not found
        return 99;
    }

    async performHealthFactorCheckPeriodic() {
        const addresses = await sqlManager.execQuery(
            "SELECT * FROM addresses WHERE healthfactor IS NULL OR healthfactor > 10"
        );
        for (const addressRecord of addresses) {
            const chainParts = addressRecord.chain.split("-");
            const userAddress = addressRecord.address;
            const healthFactor = await this.getUserHealthFactor(
                chainParts[0],
                chainParts[1],
                userAddress
            );
            await sqlManager.execQuery(
                `UPDATE addresses SET healthfactor = ${healthFactor}  WHERE address = '${userAddress}' AND chain = '${addressRecord.chain}';`
            );
        }
    }

    //#endregion healthFactor check loop
}

export default HealthFactorCheckEngine.getInstance();
