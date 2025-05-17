import crypto from "crypto";
import common from "../shared/common";
import { ethers, Transaction } from "ethers";
import Constants from "../shared/constants";
import { SecretClient } from "@azure/keyvault-secrets";
import { DefaultAzureCredential } from "@azure/identity";
import { CryptographyClient } from "@azure/keyvault-keys";
import { Network } from "alchemy-sdk";

class EncryptionManager {
    private static instance: EncryptionManager;

    private encryptionPassword: string = "";
    private secretClient: any;
    private cryptoClient: any;
    private privateKeyClient: any;

    private constructor() {
        const keyVaultUrl = "https://liquidation.vault.azure.net/";
        const credential = new DefaultAzureCredential();
        this.secretClient = new SecretClient(keyVaultUrl, credential);
        this.cryptoClient = new CryptographyClient(
            `${keyVaultUrl}keys/liquidationkey`,
            credential
        );
        this.privateKeyClient = new CryptographyClient(
            `${keyVaultUrl}keys/ethereum-signing-key`,
            credential
        );
    }

    public static getInstance(): EncryptionManager {
        if (!EncryptionManager.instance) {
            EncryptionManager.instance = new EncryptionManager();
        }
        return EncryptionManager.instance;
    }

    async signTransaction(transactionData: any): Promise<string> {
        try {
            // Create a new Transaction instance
            const tx = ethers.Transaction.from(transactionData);

            // Get the hash to sign - NOTE: Make sure this matches what Azure Key Vault expects
            // Use ethers.js hashMessage if this doesn't work
            const unsignedHash = ethers.keccak256(tx.unsignedSerialized);

            console.log(`Signing hash: ${unsignedHash}`);
            console.log(
                `Expected signer address: ${Constants.METAMASK_ADDRESS}`
            );

            // Sign with Azure Key Vault
            const signature = await this.privateKeyClient.sign(
                "ECDSA256",
                Buffer.from(unsignedHash.slice(2), "hex")
            );

            console.log(
                `Raw signature result length: ${signature.result.length}`
            );
            console.log(
                `Raw signature buffer: ${signature.result
                    .toString("hex")
                    .substring(0, 64)}...`
            );

            // Try multiple approaches to recover the signature

            // APPROACH 1: Standard DER signature parsing
            // Extract r, s components - Using strict DER parsing if Azure returns DER format
            const signatureHex = signature.result.toString("hex");
            console.log(`Signature hex: ${signatureHex}`);

            let r, s, v;

            // Extract r, s components as you were doing
            r = "0x" + signature.result.slice(0, 32).toString("hex");
            s = "0x" + signature.result.slice(32, 64).toString("hex");

            console.log(`Extracted r: ${r}`);
            console.log(`Extracted s: ${s}`);

            // Normalize 's' value (must be in lower half of curve)
            const halfCurveOrder = BigInt(
                "0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0"
            );
            const sBigInt = BigInt(s);
            const n = BigInt(
                "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F"
            );

            // Check if we need to normalize s
            const normalizeS = sBigInt > halfCurveOrder;
            if (normalizeS) {
                console.log(`Normalizing s value (${s} > halfCurveOrder)`);
                s = "0x" + (n - sBigInt).toString(16).padStart(64, "0");
                console.log(`Normalized s: ${s}`);
            }

            // Try a wide range of v values for different signature types
            // This handles various combinations of recovery bits and chain IDs
            const chainId = BigInt(transactionData.chainId);
            const vValues = [];

            // Basic v values (pre-EIP155)
            vValues.push(27, 28);

            // If s was normalized, also try the opposite v values
            if (normalizeS) {
                vValues.push(28, 27);
            }

            // Add EIP-155 v values
            if (chainId > 0n) {
                vValues.push(
                    Number(35n + chainId * 2n),
                    Number(36n + chainId * 2n),
                    // Also try the alternative formulation sometimes used
                    Number(chainId * 2n + 35n),
                    Number(chainId * 2n + 36n)
                );

                // With normalized s alternates
                if (normalizeS) {
                    vValues.push(
                        Number(36n + chainId * 2n),
                        Number(35n + chainId * 2n),
                        Number(chainId * 2n + 36n),
                        Number(chainId * 2n + 35n)
                    );
                }
            }

            console.log(
                `Trying ${vValues.length} different v values: ${vValues.join(
                    ", "
                )}`
            );

            for (const vValue of vValues) {
                try {
                    const sig = { r, s, v: BigInt(vValue) };

                    // Create a signed transaction with this signature
                    const candidateTx = tx.clone();
                    candidateTx.signature = sig;

                    const recoveredAddress = candidateTx.from;
                    console.log(`V=${vValue}: Recovered ${recoveredAddress}`);

                    // Check if this signature recovers to our expected address
                    if (
                        recoveredAddress?.toLowerCase() ===
                        Constants.METAMASK_ADDRESS.toLowerCase()
                    ) {
                        console.log(
                            `✓ Found matching signature with v=${vValue}`
                        );
                        return candidateTx.serialized;
                    }
                } catch (err: any) {
                    console.log(`Error with v=${vValue}: ${err.message}`);
                }
            }

            // APPROACH 2: Try with raw message signing as a fallback
            console.log("Trying alternative signing method...");

            try {
                // Get the message hash in a different format
                const messageHash = ethers.hashMessage(
                    ethers.getBytes(tx.unsignedSerialized)
                );
                console.log(`Alternative message hash: ${messageHash}`);

                // Re-sign with Azure
                const altSignature = await this.privateKeyClient.sign(
                    "ECDSA256",
                    Buffer.from(messageHash.slice(2), "hex")
                );

                // Try both recovery bits with this alternative approach
                for (let recoveryBit of [0, 1]) {
                    for (let tryNormalizeS of [false, true]) {
                        let altR =
                            "0x" +
                            altSignature.result.slice(0, 32).toString("hex");
                        let altS =
                            "0x" +
                            altSignature.result.slice(32, 64).toString("hex");

                        const altSBigInt = BigInt(altS);
                        if (tryNormalizeS && altSBigInt > halfCurveOrder) {
                            altS =
                                "0x" +
                                (n - altSBigInt).toString(16).padStart(64, "0");
                        }

                        let altV = recoveryBit + 27;
                        if (chainId > 0n) {
                            altV = Number(
                                BigInt(recoveryBit) + chainId * 2n + 35n
                            );
                        }

                        try {
                            const altSig = {
                                r: altR,
                                s: altS,
                                v: BigInt(altV),
                            };
                            const altTx = tx.clone();
                            altTx.signature = altSig;

                            const altRecoveredAddress = altTx.from;
                            console.log(
                                `Alt method V=${altV}: Recovered ${altRecoveredAddress}`
                            );

                            if (
                                altRecoveredAddress?.toLowerCase() ===
                                Constants.METAMASK_ADDRESS.toLowerCase()
                            ) {
                                console.log(
                                    `✓ Found matching signature with alternative method`
                                );
                                return altTx.serialized;
                            }
                        } catch (err: any) {
                            console.log(
                                `Error with alternative method: ${err.message}`
                            );
                        }
                    }
                }
            } catch (err: any) {
                console.log(
                    `Alternative signing method failed: ${err.message}`
                );
            }

            // APPROACH 3: Use a temporary wallet for debugging purposes ONLY
            console.log(
                "=== DIAGNOSTIC SECTION - Testing with a temporary wallet ==="
            );
            console.log(
                "This section is for diagnosis only and doesn't use your Azure key"
            );

            try {
                // Create a random wallet just to verify we can sign a transaction
                // This is for DIAGNOSTIC purposes only - the resulting signature is NOT used
                const tempWallet = ethers.Wallet.createRandom();
                console.log(`Temporary wallet address: ${tempWallet.address}`);

                // Sign with this wallet
                const tempSignedTx = await tempWallet.signTransaction(tx);

                console.log(
                    `Able to sign with temporary wallet: ${!!tempSignedTx}`
                );
                console.log(
                    `Transaction can be signed with a different key, indicating the signing process works`
                );
            } catch (err: any) {
                console.log(
                    `Even temporary wallet signing failed: ${err.message}`
                );
                console.log(
                    `This indicates a problem with the transaction format itself`
                );
            }

            throw new Error(
                `Could not find a valid signature recovering to ${Constants.METAMASK_ADDRESS}. 
                 This may indicate an issue with the private key or signing process.
                 Check the logs for detailed debugging information.`
            );
        } catch (error) {
            console.error("Error in signTransaction:", error);
            throw error;
        }
    }

    async ensureEncryptionPassword() {
        if (!this.encryptionPassword) {
            const encryptionPasswordEncrypted = await common.getAppSetting(
                "ENCRYPTIONPWD"
            );
            if (!encryptionPasswordEncrypted) {
                throw new Error("Encryption password not found in Key Vault");
            }
            this.encryptionPassword = await this.decryptWithKey(
                encryptionPasswordEncrypted
            );
        }
    }

    async decryptWithKey(encryptedBase64: string): Promise<string> {
        // Convert base64 string back to Uint8Array
        const ciphertext = Buffer.from(encryptedBase64, "base64");

        // Decrypt the data
        const decryptResult = await this.cryptoClient.decrypt(
            "RSA-OAEP",
            ciphertext
        );

        // Convert result back to string
        return Buffer.from(decryptResult.result).toString("utf-8");
    }

    async encryptWithKey(plainText: string) {
        // Convert string to Uint8Array
        const plaintextBuffer = Buffer.from(plainText, "utf-8");

        // Encrypt the data
        // First parameter is the algorithm, second is the data as Uint8Array
        const encryptResult = await this.cryptoClient.encrypt(
            "RSA-OAEP", // or EncryptionAlgorithm.RsaOaep256
            plaintextBuffer
        );

        return Buffer.from(encryptResult.result).toString("base64");
    }

    async encrypt(stringToEncrypt: string) {
        await this.ensureEncryptionPassword();
        const key = crypto
            .createHash("sha256")
            .update(this.encryptionPassword)
            .digest();
        const iv = crypto.randomBytes(16); // Initialization Vector for AES-256-CBC
        const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
        const encrypted = Buffer.concat([
            iv,
            cipher.update(stringToEncrypt),
            cipher.final(),
        ]);
        return encrypted.toString("hex");
    }

    async decrypt(encryptedString: string) {
        await this.ensureEncryptionPassword();
        const key = crypto
            .createHash("sha256")
            .update(this.encryptionPassword)
            .digest();

        const iv = Buffer.from(encryptedString.slice(0, 32), "hex"); // Adjust slice length for 32-byte key
        const encryptedData = Buffer.from(encryptedString.slice(32), "hex");
        const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
        const decrypted = Buffer.concat([
            decipher.update(encryptedData),
            decipher.final(),
        ]);
        return decrypted.toString("utf8");
    }

    async getSecretFromKeyVault(key: string, allowNull: boolean = false) {
        try {
            const secret = await this.secretClient.getSecret(key);
            if (!secret && !allowNull) return null;
            return secret?.value; // Return the secret value if needed
        } catch (error) {
            console.error("Error retrieving secret:", error);
            return null; // Return null or handle the error appropriately
        }
    }

    async getAndDecryptSecretFromKeyVault(key: string) {
        const value = await this.getSecretFromKeyVault(key);
        return await this.decrypt(value);
    }
}

export default EncryptionManager.getInstance();
