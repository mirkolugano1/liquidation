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
                constant: false,
                inputs: [],
                name: "renounceOwnership",
                outputs: [],
                payable: false,
                stateMutability: "nonpayable",
                type: "function",
                signature: "0x715018a6",
            },
            {
                constant: true,
                inputs: [],
                name: "owner",
                outputs: [
                    {
                        name: "",
                        type: "address",
                    },
                ],
                payable: false,
                stateMutability: "view",
                type: "function",
                signature: "0x8da5cb5b",
            },
            {
                constant: true,
                inputs: [],
                name: "isOwner",
                outputs: [
                    {
                        name: "",
                        type: "bool",
                    },
                ],
                payable: false,
                stateMutability: "view",
                type: "function",
                signature: "0x8f32d59b",
            },
            {
                constant: false,
                inputs: [
                    {
                        name: "newOwner",
                        type: "address",
                    },
                ],
                name: "transferOwnership",
                outputs: [],
                payable: false,
                stateMutability: "nonpayable",
                type: "function",
                signature: "0xf2fde38b",
            },
            {
                inputs: [
                    {
                        name: "_addressesProvider",
                        type: "address",
                    },
                ],
                payable: false,
                stateMutability: "nonpayable",
                type: "constructor",
                signature: "constructor",
            },
            {
                anonymous: false,
                inputs: [
                    {
                        indexed: false,
                        name: "_reserve",
                        type: "address",
                    },
                    {
                        indexed: false,
                        name: "_user",
                        type: "address",
                    },
                    {
                        indexed: false,
                        name: "_amount",
                        type: "uint256",
                    },
                ],
                name: "Deposit",
                type: "event",
                signature:
                    "0x5548c837ab068cf56a2c2479df0882a4922fd203edb7517321831d95078c5f62",
            },
            {
                anonymous: false,
                inputs: [
                    {
                        indexed: false,
                        name: "_reserve",
                        type: "address",
                    },
                    {
                        indexed: false,
                        name: "_user",
                        type: "address",
                    },
                    {
                        indexed: false,
                        name: "_amount",
                        type: "uint256",
                    },
                ],
                name: "Withdraw",
                type: "event",
                signature:
                    "0x9b1bfa7fa9ee420a16e124f794c35ac9f90472acc99140eb2f6447c714cad8eb",
            },
            {
                anonymous: false,
                inputs: [
                    {
                        indexed: false,
                        name: "_reserve",
                        type: "address",
                    },
                    {
                        indexed: false,
                        name: "_user",
                        type: "address",
                    },
                    {
                        indexed: false,
                        name: "_amount",
                        type: "uint256",
                    },
                ],
                name: "Borrow",
                type: "event",
                signature:
                    "0x312a5e5e1079f5dda4e95dbbd0b908b291fd5b992ef22073643ab691572c5b52",
            },
            {
                anonymous: false,
                inputs: [
                    {
                        indexed: false,
                        name: "_reserve",
                        type: "address",
                    },
                    {
                        indexed: false,
                        name: "_user",
                        type: "address",
                    },
                    {
                        indexed: false,
                        name: "_amount",
                        type: "uint256",
                    },
                ],
                name: "Repay",
                type: "event",
                signature:
                    "0x05f2eeda0e08e4b437f487c8d7d29b14537d15e3488170dc3de5dbdf8dac4684",
            },
            {
                anonymous: false,
                inputs: [
                    {
                        indexed: false,
                        name: "_collateral",
                        type: "address",
                    },
                    {
                        indexed: false,
                        name: "_user",
                        type: "address",
                    },
                    {
                        indexed: false,
                        name: "_amount",
                        type: "uint256",
                    },
                    {
                        indexed: false,
                        name: "_reserve",
                        type: "address",
                    },
                ],
                name: "CollateralCall",
                type: "event",
                signature:
                    "0xfe2cb6d8c4484341201d1f21661e93f47e7c400bfb617613c9c56425d849c9b1",
            },
            {
                anonymous: false,
                inputs: [
                    {
                        indexed: true,
                        name: "previousOwner",
                        type: "address",
                    },
                    {
                        indexed: true,
                        name: "newOwner",
                        type: "address",
                    },
                ],
                name: "OwnershipTransferred",
                type: "event",
                signature:
                    "0x8be0079c531659141344cd1fd0a4f28419497f9722a3daafe3b4186f6b6457e0",
            },
            {
                constant: false,
                inputs: [
                    {
                        name: "_reserve",
                        type: "address",
                    },
                    {
                        name: "_amount",
                        type: "uint256",
                    },
                ],
                name: "deposit",
                outputs: [],
                payable: true,
                stateMutability: "payable",
                type: "function",
                signature: "0x47e7ef24",
            },
            {
                constant: false,
                inputs: [
                    {
                        name: "_reserve",
                        type: "address",
                    },
                    {
                        name: "_amount",
                        type: "uint256",
                    },
                ],
                name: "withdraw",
                outputs: [],
                payable: false,
                stateMutability: "nonpayable",
                type: "function",
                signature: "0xf3fef3a3",
            },
            {
                constant: false,
                inputs: [
                    {
                        name: "_reserve",
                        type: "address",
                    },
                    {
                        name: "_amount",
                        type: "uint256",
                    },
                    {
                        name: "_interestRateMode",
                        type: "uint256",
                    },
                ],
                name: "borrow",
                outputs: [],
                payable: false,
                stateMutability: "nonpayable",
                type: "function",
                signature: "0xc1bce0b7",
            },
            {
                constant: false,
                inputs: [
                    {
                        name: "_reserve",
                        type: "address",
                    },
                    {
                        name: "_amount",
                        type: "uint256",
                    },
                    {
                        name: "_onBehalfOf",
                        type: "address",
                    },
                ],
                name: "repay",
                outputs: [],
                payable: true,
                stateMutability: "payable",
                type: "function",
                signature: "0x5ceae9c4",
            },
            {
                constant: false,
                inputs: [
                    {
                        name: "_reserve",
                        type: "address",
                    },
                ],
                name: "swapBorrowRateMode",
                outputs: [],
                payable: false,
                stateMutability: "nonpayable",
                type: "function",
                signature: "0x48ca1300",
            },
            {
                constant: false,
                inputs: [
                    {
                        name: "_collateral",
                        type: "address",
                    },
                    {
                        name: "_user",
                        type: "address",
                    },
                    {
                        name: "_purchaseAmount",
                        type: "uint256",
                    },
                    {
                        name: "_reserve",
                        type: "address",
                    },
                ],
                name: "collateralCall",
                outputs: [],
                payable: true,
                stateMutability: "payable",
                type: "function",
                signature: "0x3c7093b5",
            },
            {
                constant: true,
                inputs: [
                    {
                        name: "_reserve",
                        type: "address",
                    },
                ],
                name: "getReserveData",
                outputs: [
                    {
                        name: "totalLiquidity",
                        type: "uint256",
                    },
                    {
                        name: "availableLiquidity",
                        type: "uint256",
                    },
                    {
                        name: "totalBorrowsFixed",
                        type: "uint256",
                    },
                    {
                        name: "totalBorrowsVariable",
                        type: "uint256",
                    },
                    {
                        name: "liquidityRate",
                        type: "uint256",
                    },
                    {
                        name: "variableBorrowRate",
                        type: "uint256",
                    },
                    {
                        name: "fixedBorrowRate",
                        type: "uint256",
                    },
                    {
                        name: "averageFixedBorrowRate",
                        type: "uint256",
                    },
                    {
                        name: "utilizationRate",
                        type: "uint256",
                    },
                    {
                        name: "liquidityIndex",
                        type: "uint256",
                    },
                    {
                        name: "variableBorrowIndex",
                        type: "uint256",
                    },
                ],
                payable: false,
                stateMutability: "view",
                type: "function",
                signature: "0x35ea6a75",
            },
            {
                constant: true,
                inputs: [
                    {
                        name: "_user",
                        type: "address",
                    },
                ],
                name: "getUserGlobalData",
                outputs: [
                    {
                        name: "totalLiquidityETH",
                        type: "uint256",
                    },
                    {
                        name: "totalBorrowsETH",
                        type: "uint256",
                    },
                    {
                        name: "currentLiquidationRatio",
                        type: "uint256",
                    },
                    {
                        name: "ltv",
                        type: "uint256",
                    },
                    {
                        name: "isBelowLiquidationThreshold",
                        type: "bool",
                    },
                ],
                payable: false,
                stateMutability: "view",
                type: "function",
                signature: "0xe1fa02ba",
            },
            {
                constant: true,
                inputs: [
                    {
                        name: "_reserve",
                        type: "address",
                    },
                    {
                        name: "_user",
                        type: "address",
                    },
                ],
                name: "getUserReserveData",
                outputs: [
                    {
                        name: "currentLiquidityBalance",
                        type: "uint256",
                    },
                    {
                        name: "currentBorrowBalance",
                        type: "uint256",
                    },
                    {
                        name: "principalLiquidityBalance",
                        type: "uint256",
                    },
                    {
                        name: "principalBorrowBalance",
                        type: "uint256",
                    },
                    {
                        name: "borrowRateMode",
                        type: "uint256",
                    },
                    {
                        name: "borrowRate",
                        type: "uint256",
                    },
                    {
                        name: "liquidityRate",
                        type: "uint256",
                    },
                    {
                        name: "originationFee",
                        type: "uint256",
                    },
                    {
                        name: "liquidityIndex",
                        type: "uint256",
                    },
                    {
                        name: "variableBorrowIndex",
                        type: "uint256",
                    },
                ],
                payable: false,
                stateMutability: "view",
                type: "function",
                signature: "0x28dd2d01",
            },
        ];
        //end setup and variables definition

        const provider = new ethers.JsonRpcProvider(alchemyUrl);

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
