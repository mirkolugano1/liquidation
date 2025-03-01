import common from "../common/common";
import _ from "lodash";
import encryption from "../common/encryption";
import { CloudStorageManager } from "../common/cloudStorageManager";
import fileUtilities from "../common/fileUtilities";
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

    async initializeHealthFactorCheckLoop() {
        await common.checkRequiredEnvironmentVariables(
            this.requiredEnvironmentVariables
        );

        const _privateKey = await common.getAppSetting("PRIVATEKEYENCRYPTED");
        const _alchemyKey = await common.getAppSetting("ALCHEMYKEYENCRYPTED");
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
            await fileUtilities.readFromTextFile(
                "/home/data/lendingPoolAbi.json"
            )
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

        //await fileUtilities.ensureFileExists(common.addressesFilePath);
    }

    balanceOfAbi = ["function balanceOf(address) view returns (uint256)"];

    async getAddressesToCheckHealthFactor() {
        const addressesText = await fileUtilities.readFromTextFile(
            "./data/addresses_mainnet.txt"
        );
        let addresses = addressesText.split("\n");
        if (addresses.length == 0) throw new Error("No addresses found");

        return addresses;
    }

    reserves: any = {};

    async test() {
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
                    /*
                    TODO?
                    Liquidators must approve() the Pool contract to use debtToCover of the underlying ERC20 of the asset used for the liquidation.
                    */

                    // Liquidate the user's debt
                    if (this.liquidationEnabled) {
                        //TODO call smart contract flashloan + liquidation procedure
                        /*
                        await this.approveDebtToCover(
                            assetsToLiquidate,
                            userAccountData
                        );

                        common.log("liquidating address: " + address);
                        await this.lendingPoolContract.liquidationCall(
                            assetsToLiquidate.collateralAsset, //collateral asset
                            assetsToLiquidate.debtAsset, //debt asset
                            address, //user address (borrwer)
                            -1, //liquidate max possible debt (50% of collateral)
                            true //receive aTokens
                        );
                        */
                    } else {
                        common.log("liquidation disabled");
                    }
                }
            } catch (error) {
                console.error("Error:", error);
            }
        }
    }

    async approveDebtToCover(assets: any, userAccountData: any) {
        let reserveData = this.reserves[assets.collateralAsset];
        let aTokenAddress = reserveData.aTokenAddress;

        const aTokenContract = new ethers.Contract(
            aTokenAddress,
            ["function approve(address spender, uint256 amount)"],
            this.signer
        );

        // Approve the user's total debt
        const tx = await aTokenContract.approve(
            this.lendingPoolAddress,
            userAccountData[1] //totalDebtBase TODO: need to convert this to collateral aToken equivalent?
        );
        await tx.wait();
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

    async performHealthFactorCheckLoop() {
        while (true) {
            common.log("HFCE: start loop healthCheck factor check");
            let addressesText = await fileUtilities.readFromTextFile(
                common.addressesFilePath
            );
            this.addresses = addressesText?.split("\n") || [];

            for (const userAddress of this.addresses) {
                // Get user account data
                const userAccountData =
                    await this.lendingPoolContract.getUserGlobalData(
                        userAddress
                    );

                // Extract health factor
                //const healthFactor = userAccountData[5];

                common.log(
                    "account: " +
                        userAddress +
                        ", data: " +
                        JSON.stringify(userAccountData)
                );
                /*
                // Fetch market prices (replace with actual price fetching logic)
                const collateralAssetPrice = await this.fetchMarketPrice(
                    "0xCollateralAsset"
                );
                const debtAssetPrice = await this.fetchMarketPrice(
                    "0xDebtAsset"
                );

                // Calculate collateral value
                const collateralValue =
                    userAccountData[2].mul(collateralAssetPrice);
                const debtValue = userAccountData[3].mul(debtAssetPrice);

                if (healthFactor.lt(ethers.constants.One)) {
                    // Prepare liquidation call
                    const liquidateFunction =
                        this.lendingPoolContract.functions.liquidationCall(
                            userAddress,
                            "0xCollateralAsset",
                            "0xDebtAsset",
                            ethers.constants.MaxUint256, // Liquidate entire debt
                            true // Receive aTokens
                        );

                    // Estimate gas cost
                    const gasEstimate = await liquidateFunction.estimateGas();

                    // Send liquidation transaction
                    const tx = await liquidateFunction.send({
                        gasLimit: gasEstimate.add(1000), // Add some buffer
                    });

                    common.log(
                        `Transaction Hash: ${tx.hash} for user: ${userAddress}`
                    );
                    common.log(`Waiting for transaction confirmation...`);

                    // Wait for transaction confirmation
                    const receipt = await tx.wait();

                    common.log(
                        `Transaction confirmed: ${receipt.transactionHash}`
                    );                    
                }
                    */
            }
        }
    }

    async fetchMarketPrice(assetAddress: string) {
        // Replace with your oracle service or API call
        // For simplicity, return a fixed price
        return ethers.utils.parseEther("200.00");
    }

    //#endregion healthFactor check loop
}

export default HealthFactorCheckEngine.getInstance();
