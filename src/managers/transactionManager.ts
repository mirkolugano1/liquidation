import Constants from "../shared/constants";
import { Network } from "alchemy-sdk";
import common from "../shared/common";
import _, { chunk } from "lodash";
import encryptionManager from "./encryptionManager";
import { ethers } from "ethers";
import logger from "../shared/logger";
import Big from "big.js";

class TransactionManager {
    private static instance: TransactionManager;
    private lastNonce: number | null = null;
    private nonceLock = false;
    private liquidationContract: any;

    public static getInstance(): TransactionManager {
        if (!TransactionManager.instance) {
            TransactionManager.instance = new TransactionManager();
        }
        return TransactionManager.instance;
    }

    private constructor() {}

    //#region multicall

    /**
     * Batches multiple calls to a smartContract using the Multicall3 contract.
     *
     * @param targetAddresses the smartContract addresses(es) to call the method on
     * @param paramAddresses the method parameters for each smartContract address
     * @param contractABI the smartContract ABI of the function to be called
     * @param methodName the method name to be called
     * @param network the blockchain network from the AlchemySDK e.g. Network.ETH_MAINNET
     * @param usePrivateTransaction whether to use a private transaction, which is, every transaction which changes chain state (default: false)
     * @param estimateGas whether to estimate gas for the multicall (default: false)
     * @returns
     */
    async multicall(
        targetAddresses: string | string[],
        params: any | any[] | null,
        contractABI: any,
        methodNames: string | string[],
        network: Network,
        usePrivateTransaction: boolean = false,
        estimateGas: boolean = false
    ) {
        [targetAddresses, params, methodNames] = this.checkMulticallInputs(
            targetAddresses,
            params,
            contractABI,
            methodNames,
            network
        );

        const multicallContract = common.getContract(
            Constants.MULTICALL3_ADDRESS,
            Constants.ABIS.MULTICALL3_ABI,
            network
        );

        const calls = _.map(
            targetAddresses,
            (targetAddress: string, index: number) => {
                const contractInterface =
                    common.getContractInterface(contractABI);

                let currentParams = params ? params[index] : null;
                let calldata;

                if (!currentParams) {
                    // No params case
                    calldata = contractInterface.encodeFunctionData(
                        methodNames[index]
                    );
                } else if (Array.isArray(currentParams)) {
                    // Array of params case
                    calldata = contractInterface.encodeFunctionData(
                        methodNames[index],
                        currentParams
                    );
                } else {
                    // Single param case
                    calldata = contractInterface.encodeFunctionData(
                        methodNames[index],
                        [currentParams]
                    );
                }

                return {
                    target: targetAddress,
                    callData: calldata,
                };
            }
        );

        const aaveNetworkInfo = common.getAaveNetworkInfo(network);
        if (estimateGas) {
            return await aaveNetworkInfo.alchemyProvider.estimateGas(calls);
        } else {
            // Split into chunks of 1000 or fewer calls
            const callBatches = _.chunk(calls, Constants.CHUNK_SIZE);

            // Create a tracking array to map chunk results back to original indices
            const callIndices = Array.from(
                { length: calls.length },
                (_, i) => i
            );
            const indexBatches = _.chunk(callIndices, Constants.CHUNK_SIZE);
            const chainId = aaveNetworkInfo.chainId;
            const txBase = {
                to: Constants.MULTICALL3_ADDRESS,
                value: 0n, // If no ETH is being sent (BigInt for ethers v6)
                gasLimit: 2000000n, // Estimate gas limit (BigInt for ethers v6)
                //gasPrice: 5n * 10n ** 9n, // (Optional if using EIP-1559)
                maxFeePerGas: 30n * 10n ** 9n, // Maximum fee per gas (EIP-1559)
                maxPriorityFeePerGas: 2n * 10n ** 9n, // Maximum tip (EIP-1559)
                chainId: chainId,
            };

            const transactionSimulationErrors: Map<string, any> = new Map();

            // Execute each chunk
            const chunkPromises = callBatches.map(async (callBatch, index) => {
                if (usePrivateTransaction) {
                    const calldata =
                        multicallContract.interface.encodeFunctionData(
                            "aggregate", // Multicall3's aggregate method
                            [callBatch]
                        );
                    const nonce = await this.getAndLockNonce(
                        aaveNetworkInfo.alchemyProvider,
                        Constants.METAMASK_ADDRESS
                    );
                    const tx = {
                        ...txBase,
                        data: calldata,
                        nonce: nonce,
                    };

                    // Sign the transaction
                    const signedTx = await encryptionManager.signTransaction(
                        tx
                    );

                    //Simulate the transaction
                    const simulatedTx = {
                        ...tx,
                        from: Constants.METAMASK_ADDRESS,
                    };
                    const simulationResult = await this.simulateTransaction(
                        aaveNetworkInfo.alchemyProvider.connection.url,
                        simulatedTx
                    );
                    if (!simulationResult.success) {
                        transactionSimulationErrors.set(
                            index.toString(),
                            simulationResult.error
                        );
                        return null;
                    }

                    switch (network) {
                        case Network.ETH_MAINNET:
                        case Network.ETH_SEPOLIA:
                        case Network.ETH_GOERLI:
                            // For Ethereum mainnet and Sepolia, use Alchemy's private transaction
                            return aaveNetworkInfo.alchemy.transact.sendPrivateTransaction(
                                signedTx
                            );
                        default:
                            // For other networks, use Flashbots (alchemy does not support private transactions other than mainnet, sepolia and goerli)
                            return aaveNetworkInfo.flashbotsProvider.broadcastTransaction(
                                signedTx
                            );
                    }
                } else return multicallContract.aggregate(callBatch);
            });

            //exclude transactions that failed simulation from execution
            const chunkPromisesToExecute = chunkPromises.map(
                (promise: any, index) => promise
            );

            const chunkResults = await Promise.all(chunkPromisesToExecute);
            if (usePrivateTransaction) {
                if (transactionSimulationErrors.size > 0) {
                    await logger.warning(
                        `Transaction simulation errors: ${JSON.stringify(
                            Object.fromEntries(transactionSimulationErrors)
                        )} `
                    );
                }

                return chunkPromisesToExecute.length === 0 ? [] : chunkResults;
            }

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
                    const contractInterface =
                        common.getContractInterface(contractABI);

                    const decodedResult =
                        contractInterface.decodeFunctionResult(
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

    //#endregion multicall

    //#region simulateTransaction

    async simulateTransaction(rpcUrl: string, transaction: any) {
        try {
            // Create a provider using the RPC URL
            const provider = new ethers.JsonRpcProvider(rpcUrl);

            // Prepare the transaction object
            const txObject = {
                from: transaction.from || Constants.METAMASK_ADDRESS,
                to: transaction.to,
                data: transaction.data,
                value: transaction.value || "0x0",
                // Note: We're intentionally omitting gas parameters
                // to let the node estimate them
            };

            // Use eth_call to simulate the transaction
            const result = await provider.call(txObject);

            return {
                success: true,
                result: result,
            };
        } catch (error: any) {
            return {
                success: false,
                error: error.message || String(error),
            };
        }
    }

    //#endregion simulateTransaction

    //#region sendSingleTransaction

    async sendSingleTransaction(
        aaveNetworkInfo: any,
        methodName: string,
        methodParams: any
    ) {
        if (!Array.isArray(methodParams)) methodParams = [methodParams];

        if (!this.liquidationContract) {
            this.liquidationContract = common.getContract(
                aaveNetworkInfo.liquidationContractAddress,
                Constants.ABIS.LIQUIDATION_ABI,
                aaveNetworkInfo.network
            );
        }

        const nonce = await this.getAndLockNonce(
            aaveNetworkInfo.alchemyProvider,
            Constants.METAMASK_ADDRESS
        );

        const gasEstimate = await this.liquidationContract[
            methodName
        ].estimateGas(...methodParams);

        // Build the transaction
        const tx = await this.liquidationContract[
            methodName
        ].populateTransaction(...methodParams);

        tx.gasLimit =
            typeof gasEstimate === "bigint"
                ? gasEstimate
                : BigInt(gasEstimate.toString());
        tx.nonce = nonce;
        tx.chainId = aaveNetworkInfo.chainId;

        const feeData = await aaveNetworkInfo.alchemyProvider.getFeeData();
        tx.maxFeePerGas =
            typeof feeData.maxFeePerGas === "bigint"
                ? feeData.maxFeePerGas
                : BigInt(feeData.maxFeePerGas.toString());

        tx.maxPriorityFeePerGas =
            typeof feeData.maxPriorityFeePerGas === "bigint"
                ? feeData.maxPriorityFeePerGas
                : BigInt(feeData.maxPriorityFeePerGas.toString());

        // Sign the transaction
        const signedTx = await encryptionManager.signTransaction(tx);

        //Simulate the transaction
        const simulatedTx = {
            ...tx,
            from: Constants.METAMASK_ADDRESS,
        };
        const simulationResult = await this.simulateTransaction(
            aaveNetworkInfo.alchemyProvider.connection.url,
            simulatedTx
        );
        if (!simulationResult.success) {
            await logger.warning(
                `Transaction simulation failed: ${simulationResult.error}`
            );
            return simulationResult;
        }

        switch (aaveNetworkInfo.network) {
            case Network.ETH_MAINNET:
            case Network.ETH_SEPOLIA:
            case Network.ETH_GOERLI:
                // For Ethereum mainnet and Sepolia, use Alchemy's private transaction
                return aaveNetworkInfo.alchemy.transact.sendPrivateTransaction(
                    signedTx
                );
            default:
                // For other networks, use Flashbots (alchemy does not support private transactions other than mainnet, sepolia and goerli)
                return aaveNetworkInfo.flashbotsProvider.broadcastTransaction(
                    signedTx
                );
        }
    }

    //#endregion sendSingleTransaction

    //#region getAndLockNonce

    private async getAndLockNonce(
        provider: any,
        address: string
    ): Promise<number | null> {
        // Wait if another transaction is currently getting a nonce
        while (this.nonceLock) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        this.nonceLock = true;

        try {
            // Always get the current nonce from the network
            const currentNonce = await provider.getTransactionCount(address);

            // If our lastNonce is null or behind the network nonce, update it
            if (this.lastNonce === null || currentNonce > this.lastNonce) {
                this.lastNonce = currentNonce;
            } else {
                // If our cached nonce is ahead of the network, increment it
                this.lastNonce++;
            }

            return this.lastNonce;
        } finally {
            this.nonceLock = false;
        }
    }

    //#region getAndLockNonce

    //#region multicallEstimateGas

    async multicallEstimateGas(
        targetAddresses: string,
        paramAddresses: string | string[] | null,
        contractABIsKeys: string | string[],
        methodNames: string | string[],
        network: Network
    ) {
        const estimate = await this.multicall(
            targetAddresses,
            paramAddresses,
            contractABIsKeys,
            methodNames,
            network,
            true
        );
        return Number(estimate);
    }

    //#endregion multicallEstimateGas

    //#region checkMulticallInputs

    checkMulticallInputs(
        targetAddresses: string | string[],
        params: string | string[] | null,
        contractABI: any,
        methodNames: string | string[],
        network: Network
    ): [string[], string[], string[]] {
        if (!network) throw new Error("No network provided");
        if (!params) params = [];

        if (!targetAddresses || targetAddresses.length == 0)
            throw new Error("No targetAddresses provided");

        if (!Array.isArray(targetAddresses))
            targetAddresses = [targetAddresses];

        if (!Array.isArray(methodNames)) methodNames = [methodNames];

        if (
            targetAddresses.length == 1 &&
            params &&
            Array.isArray(params) &&
            params.length > 1
        ) {
            targetAddresses = Array(params.length).fill(targetAddresses[0]);
        } else if (targetAddresses.length == 1 && methodNames.length > 1) {
            targetAddresses = Array(methodNames.length).fill(
                targetAddresses[0]
            );
        }

        if (!Array.isArray(params)) params = [params];

        if (
            params.length == 1 &&
            targetAddresses &&
            Array.isArray(targetAddresses) &&
            targetAddresses.length > 1
        ) {
            params = Array(targetAddresses.length).fill(params[0]);
        }

        if (params.length > 0 && targetAddresses.length != params.length) {
            throw new Error("targetAddresses and params length mismatch");
        }

        if (!methodNames || methodNames.length == 0)
            throw new Error("No methodNames provided");

        if (
            methodNames.length == 1 &&
            targetAddresses &&
            Array.isArray(targetAddresses) &&
            targetAddresses.length > 1
        ) {
            methodNames = Array(targetAddresses.length).fill(methodNames[0]);
        }

        if (targetAddresses.length != methodNames.length) {
            throw new Error("targetAddresses and methodNames length mismatch");
        }

        if (!contractABI) throw new Error("No contractABI provided");

        return [targetAddresses, params, methodNames];
    }

    //#endregion checkMulticallInputs
}
export default TransactionManager.getInstance();
