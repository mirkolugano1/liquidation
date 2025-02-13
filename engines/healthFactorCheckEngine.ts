import common from "../common/common";
import _ from "lodash";
import encryption from "../common/encryption";
import { CloudStorageManager } from "../common/cloudStorageManager";
import fileUtilities from "../common/fileUtilities";
const { ethers } = require("ethers");

class HealthFactorCheckEngine {
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

    lendingPoolContract: any;

    async initializeHealthFactorCheckLoop() {
        common.checkRequiredEnvironmentVariables(
            this.requiredEnvironmentVariables
        );

        //Load required environment variables
        const _privateKey = process.env.PRIVATEKEYENCRYPTED; //Metamask
        const _alchemyKey = process.env.ALCHEMYKEYENCRYPTED;
        const _encryptionPwd = process.env.ENCRYPTIONPWD!;
        //load for required environment variables

        //Setup & variables definition
        const ethers = require("ethers");
        const alchemyUrl = `https://eth-mainnet.g.alchemy.com/v2/${_alchemyKey}`;
        const privateKey = await encryption.decrypt(
            _privateKey || "",
            _encryptionPwd
        );
        const lendingPoolAddress = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2";
        const lendingPoolAbi = [
            {
                inputs: [
                    { internalType: "address", name: "admin", type: "address" },
                ],
                stateMutability: "nonpayable",
                type: "constructor",
            },
            {
                anonymous: false,
                inputs: [
                    {
                        indexed: true,
                        internalType: "address",
                        name: "implementation",
                        type: "address",
                    },
                ],
                name: "Upgraded",
                type: "event",
            },
            { stateMutability: "payable", type: "fallback" },
            {
                inputs: [],
                name: "admin",
                outputs: [
                    { internalType: "address", name: "", type: "address" },
                ],
                stateMutability: "nonpayable",
                type: "function",
            },
            {
                inputs: [],
                name: "implementation",
                outputs: [
                    { internalType: "address", name: "", type: "address" },
                ],
                stateMutability: "nonpayable",
                type: "function",
            },
            {
                inputs: [
                    {
                        internalType: "address",
                        name: "_logic",
                        type: "address",
                    },
                    { internalType: "bytes", name: "_data", type: "bytes" },
                ],
                name: "initialize",
                outputs: [],
                stateMutability: "payable",
                type: "function",
            },
            {
                inputs: [
                    {
                        internalType: "address",
                        name: "newImplementation",
                        type: "address",
                    },
                ],
                name: "upgradeTo",
                outputs: [],
                stateMutability: "nonpayable",
                type: "function",
            },
            {
                inputs: [
                    {
                        internalType: "address",
                        name: "newImplementation",
                        type: "address",
                    },
                    { internalType: "bytes", name: "data", type: "bytes" },
                ],
                name: "upgradeToAndCall",
                outputs: [],
                stateMutability: "payable",
                type: "function",
            },
        ];
        //end setup and variables definition

        const provider = new ethers.JsonRpcProvider(alchemyUrl);
        console.log(privateKey);
        // Create a signer from private key
        const signer = new ethers.Wallet(privateKey, provider);

        // Create a contract instance for LendingPool
        this.lendingPoolContract = new ethers.Contract(
            lendingPoolAddress,
            lendingPoolAbi,
            signer
        );

        await fileUtilities.ensureFileExists(common.addressesFilePath);

        common.log("HFCE: init complete");
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
                    await this.lendingPoolContract.getUserAccountData(
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
