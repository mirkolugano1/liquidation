import Constants from "../shared/constants";
import { Network } from "alchemy-sdk";
import common from "../shared/common";
import _, { chunk } from "lodash";
import encryptionManager from "./encryptionManager";

class MulticallManager {
    private static instance: MulticallManager;
    private lastNonce: number | null = null;
    private nonceLock = false;

    public static getInstance(): MulticallManager {
        if (!MulticallManager.instance) {
            MulticallManager.instance = new MulticallManager();
        }
        return MulticallManager.instance;
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
     * @returns
     */
    async multicall(
        targetAddresses: string | string[],
        params: any | any[] | null,
        contractABIsKeys: string | string[],
        methodNames: string | string[],
        network: Network,
        usePrivateTransaction: boolean = false,
        estimateGas: boolean = false
    ) {
        [targetAddresses, params, contractABIsKeys, methodNames] =
            this.checkMulticallInputs(
                targetAddresses,
                params,
                contractABIsKeys,
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
                const contractInterface = common.getContractInterface(
                    Constants.ABIS[contractABIsKeys[index]]
                );

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
                gasPrice: 5n * 10n ** 9n, // (Optional if using EIP-1559)
                maxFeePerGas: 30n * 10n ** 9n, // Maximum fee per gas (EIP-1559)
                maxPriorityFeePerGas: 2n * 10n ** 9n, // Maximum tip (EIP-1559)
                chainId: chainId,
            };

            // Execute each chunk
            const chunkPromises = callBatches.map(async (callBatch) => {
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

                    switch (network) {
                        case Network.ETH_MAINNET:
                        case Network.ETH_SEPOLIA:
                        case Network.ETH_GOERLI:
                            // For Ethereum mainnet and Sepolia, use Alchemy's private transaction
                            return aaveNetworkInfo.alchemyProvider.send(
                                "eth_sendPrivateTransaction",
                                [
                                    { tx: signedTx, maxBlockNumber: null }, // Optional: Specify maxBlockNumber
                                ]
                            );
                        default:
                            // For other networks, use Flashbots (alchemy does not support private transactions other than mainnet, sepolia and goerli)
                            return aaveNetworkInfo.flashbotsProvider.broadcastTransaction(
                                signedTx
                            );
                    }
                } else return multicallContract.aggregate(callBatch);
            });

            const chunkResults = await Promise.all(chunkPromises);
            if (usePrivateTransaction) return chunkResults;

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
                    const contractInterface = common.getContractInterface(
                        Constants.ABIS[contractABIsKeys[originalIndex]]
                    );

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
        targetAddresses: string | string[],
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
        contractABIsKeys: string | string[],
        methodNames: string | string[],
        network: Network
    ): [string[], string[], string[], string[]] {
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

        if (!contractABIsKeys || contractABIsKeys.length == 0)
            throw new Error("No contractABIs provided");

        if (!Array.isArray(contractABIsKeys))
            contractABIsKeys = [contractABIsKeys];

        if (
            contractABIsKeys.length == 1 &&
            targetAddresses &&
            Array.isArray(targetAddresses) &&
            targetAddresses.length > 1
        ) {
            contractABIsKeys = Array(targetAddresses.length).fill(
                contractABIsKeys[0]
            );
        }

        if (targetAddresses.length != contractABIsKeys.length) {
            throw new Error("targetAddresses and contractABIs length mismatch");
        }

        return [targetAddresses, params, contractABIsKeys, methodNames];
    }

    //#endregion checkMulticallInputs
}
export default MulticallManager.getInstance();
