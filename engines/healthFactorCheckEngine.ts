import common from "../common/common";
import _, { forEach } from "lodash";
import encryption from "../common/encryption";
import { CloudStorageManager } from "../managers/cloudStorageManager";
import graphManager from "../managers/graphManager";
import fileUtilities from "../common/fileUtilities";
import sqlManager from "../managers/sqlManager";
const { ethers, formatUnits } = require("ethers");

class HealthFactorCheckEngine {
    //#region TODO remove or change them when ready to go live
    liquidationEnabled: boolean = false;
    forceLiquidationWorkflow: boolean = true;
    //#endregion

    requiredEnvironmentVariables: string[] = [
        "ENCRYPTIONPWD",
        "PRIVATEKEYENCRYPTED",
        "LIQUIDATIONENVIRONMENT",
        "APPLICATIONINSIGHTS_CONNECTION_STRING",
    ];

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

    signer: any;
    testContract: any;
    lendingPoolContract: any;
    lendingPoolAddress: string = "";

    async initializeHealthFactorEngine() {
        if (this.lendingPoolContract) return;

        await common.checkRequiredEnvironmentVariables(
            this.requiredEnvironmentVariables
        );

        const _privateKey = await encryption.getSecretFromKeyVault(
            "PRIVATEKEYENCRYPTED"
        );
        const _alchemyKey = await encryption.getSecretFromKeyVault(
            "ALCHEMYKEYENCRYPTED"
        );
        const alchemyKey = await encryption.decrypt(_alchemyKey || "");
        //load for required environment variables

        //Setup & variables definition
        const alchemyNetwork = common.isProd ? "mainnet" : "sepolia";
        const alchemyUrl = `https://eth-${alchemyNetwork}.g.alchemy.com/v2/${alchemyKey}`;
        const privateKey = await encryption.decrypt(_privateKey || "");
        this.lendingPoolAddress = common.isProd
            ? "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2"
            : "0x7d2768de32b0b80b7a3454c06bdac94a69ddc7a9";

        const lendingPoolAbi = JSON.parse(
            await fileUtilities.readFromTextFile("json/lendingPoolAbi.json")
        );
        //end setup and variables definition

        const provider = new ethers.JsonRpcProvider(alchemyUrl);

        // Create a signer from private key
        this.signer = new ethers.Wallet(privateKey, provider);

        const contractAbi = [
            "function getUserAccountData(address user) view returns (uint256 totalCollateralETH, uint256 totalDebtETH, uint256 availableBorrowsETH, uint256 currentLiquidationThreshold, uint256 ltv, uint256 healthFactor)",
            "function getUserEMode(address user) external view returns (uint256)",
            "function liquidationCall(address collateralAsset, address debtAsset, address user, uint256 debtToCover, bool receiveAToken) external returns (uint256, uint256, uint256)",
            "function getReservesList() external view returns (address[] memory)",
            "function getReserveData(address asset) external view returns (uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, uint40 liquidationGracePeriodUntil, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt, uint128 virtualUnderlyingBalance)",
            "function getUserConfiguration(address user) external view returns (uint256 configuration)",
        ];

        // Create a contract instance for LendingPool
        this.lendingPoolContract = new ethers.Contract(
            this.lendingPoolAddress,
            contractAbi, //lendingPoolAbi,
            this.signer
        );
    }

    balanceOfAbi = ["function balanceOf(address) view returns (uint256)"];

    async getAddressesToCheckHealthFactor() {
        const dbAddressesArr = await sqlManager.execQuery(
            "SELECT * FROM addresses"
        );
        return dbAddressesArr.map((a: any) => a.address);
    }

    reserves: any = {};

    userReservesQueryBase = `
        {
            userReserves(where: { user_in: ["{0}"] }) {
                user {
                    id
                }
                reserve {
                    symbol
                    decimals
                    price {
                        priceInEth
                    }
                    reserveLiquidationThreshold
                }
                currentATokenBalance
                currentVariableDebt
            }
        }
    `;

    async fetchUsersReserves(userAddresses: string[]) {
        const query = this.userReservesQueryBase.replace(
            "{0}",
            userAddresses.join('","')
        );
        return await graphManager.execQuery(query);
    }

    async test() {
        console.log("test successful");
    }

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
                    common.log(
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
                        common.log("liquidation disabled");
                    }
                }
            } catch (error) {
                console.error("Error:", error);
            }
        }
    }

    /**
     *   Example input: 1000000000000000000001001000000000110000
     *   Explanation of userConfiguration
     *   https://aave.com/docs/developers/smart-contracts/pool#view-methods-getuserconfiguration
     */
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

    async getUserHealthFactor(address: string, decimals: number = 18) {
        await this.initializeHealthFactorEngine();
        // Get user account data
        const userAccountData =
            await this.lendingPoolContract.getUserAccountData(address);

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
            const userAddress = addressRecord.address;
            const healthFactor = await this.getUserHealthFactor(userAddress);
            await sqlManager.execQuery(
                `UPDATE addresses SET healthfactor = ${healthFactor}  WHERE address = '${userAddress}';`
            );
        }
    }

    //#endregion healthFactor check loop
}

export default HealthFactorCheckEngine.getInstance();
