import common from "../common/common";
import _, { forEach } from "lodash";
import encryption from "../common/encryption";
import { CloudStorageManager } from "../managers/cloudStorageManager";
import graphManager from "../managers/graphManager";
import fileUtilities from "../common/fileUtilities";
import sqlManager from "../managers/sqlManager";
import { ethers, formatUnits } from "ethers";

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

    lendingPoolContractsInfos: any[] = [
        {
            chain: "eth",
            chainEnv: "mainnet",
            lendingPoolAddress: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
        },
        {
            chain: "arb",
            chainEnv: "mainnet",
            lendingPoolAddress: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
        },
    ];

    lendingPoolContracts: any;

    async initializeHealthFactorEngine() {
        if (this.lendingPoolContracts) return;

        const privateKey = await encryption.getAndDecryptSecretFromKeyVault(
            "PRIVATEKEYENCRYPTED"
        );
        const alchemyKey = await encryption.getAndDecryptSecretFromKeyVault(
            "ALCHEMYKEYENCRYPTED"
        );

        for (const o of this.lendingPoolContractsInfos) {
            const key = `${o.chain}-${o.chainEnv}`;
            this.lendingPoolContracts[key] = this.setLendingPoolContract(
                privateKey,
                alchemyKey,
                o.lendingPoolAddress,
                o.chain,
                o.chainEnv //"sepolia"
            );
        }
    }

    lendingPoolContractAbi = [
        "function getUserAccountData(address user) view returns (uint256 totalCollateralETH, uint256 totalDebtETH, uint256 availableBorrowsETH, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
        "function getUserEMode(address user) external view returns (uint256)",
        "function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken) external returns (uint256, uint256, uint256)",
        "function getReservesList() external view returns (address[] memory)",
        "function getReserveData(address asset) external view returns (uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, uint40 liquidationGracePeriodUntil, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt, uint128 virtualUnderlyingBalance)",
        "function getUserConfiguration(address user) external view returns (uint256 configuration)",
    ];

    async setLendingPoolContract(
        privateKey: string,
        alchemyKey: string,
        lendingPoolAddress: string,
        alchemyChainAbbrev: string,
        alchemyChainEnvironment: string = "mainnet"
    ) {
        const alchemyUrl = `https://${alchemyChainAbbrev}-${alchemyChainEnvironment}.g.alchemy.com/v2/${alchemyKey}`;
        const provider = new ethers.JsonRpcProvider(alchemyUrl);
        const signer = new ethers.Wallet(privateKey, provider);

        return new ethers.Contract(
            lendingPoolAddress,
            this.lendingPoolContractAbi,
            signer
        );
    }

    getLendingPoolContract(chain: string, chainEnv: string = "mainnet") {
        const key = `${chain}-${chainEnv}`;
        return this.lendingPoolContracts[key];
    }

    async getHealthFactor(chain: string, address: string) {
        await this.initializeHealthFactorEngine();
        let userAccountData = await this.getLendingPoolContract(
            chain
        ).getUserAccountData(address);

        const healthFactorStr = formatUnits(userAccountData[5], 18);
        return parseFloat(healthFactorStr);
    }

    balanceOfAbi = ["function balanceOf(address) view returns (uint256)"];

    async getAddressesToCheckHealthFactor() {
        const dbAddressesArr = await sqlManager.execQuery(
            "SELECT * FROM addresses"
        );
        return dbAddressesArr.map((a: any) => a.address);
    }

    reserves: any = {};

    async fetchAllUsersReserves(userAddresses: string[]) {
        const ADDRESSES_BATCH_SIZE = 300; // Number of addresses per batch 200
        const RESERVES_BATCH_SIZE = 500; // Number of userReserves per query 500
        let allUserReserves: any = [];

        for (let i = 0; i < userAddresses.length; i += ADDRESSES_BATCH_SIZE) {
            console.log("addresses batch start");
            const addressBatch = userAddresses.slice(
                i,
                i + ADDRESSES_BATCH_SIZE
            );
            let skip = 0;
            let hasMore = true;

            while (hasMore) {
                console.log("reserves batch start");
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
        console.log(allUserReserves.length);
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

            console.log(`Symbol: ${reserve.reserve.symbol}`);
            console.log(`Collateral Amount: ${collateralAmount}`);
            console.log(`Debt Amount: ${debtAmount}`);
            console.log(`Price: ${price}`);
            console.log(`Liquidation Threshold: ${liquidationThreshold}`);
            console.log(`Decimals: ${decimals}`);

            if (collateralAmount > 0n && price > 0n) {
                const collateralValueInEth =
                    (collateralAmount * price * liquidationThreshold) /
                    (10000n * 10n ** BigInt(decimals));
                console.log(`Collateral Value: ${collateralValueInEth}`);
                totalCollateralInEth += collateralValueInEth;
            }

            if (debtAmount > 0n && price > 0n) {
                const debtValueInEth =
                    (debtAmount * price) / 10n ** BigInt(decimals);
                console.log(`Debt Value: ${debtValueInEth}`);
                totalDebtInEth += debtValueInEth;
            }
            console.log("---");
        }

        console.log(`Total Collateral: ${totalCollateralInEth}`);
        console.log(`Total Debt: ${totalDebtInEth}`);

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
        const userAccountData = await this.lendingPoolContracts[
            key
        ].getUserAccountData(address);

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

    async performHealthFactorCheckPeriodic(
        chain: string,
        chainEnv: string = "mainnet"
    ) {
        const key = `${chain}-${chainEnv}`;
        const addresses = await sqlManager.execQuery(
            "SELECT * FROM addresses WHERE healthfactor IS NULL OR healthfactor > 10"
        );
        for (const addressRecord of addresses) {
            const userAddress = addressRecord.address;
            const healthFactor = await this.getUserHealthFactor(
                chain,
                chainEnv,
                userAddress
            );
            await sqlManager.execQuery(
                `UPDATE addresses SET healthfactor = ${healthFactor}  WHERE address = '${userAddress}' AND chain = '${key}';`
            );
        }
    }

    //#endregion healthFactor check loop
}

export default HealthFactorCheckEngine.getInstance();
