import crypto from "crypto";
import common from "../shared/common";
import { ethers, Transaction } from "ethers";
import Constants from "../shared/constants";
import { SecretClient } from "@azure/keyvault-secrets";
import { DefaultAzureCredential } from "@azure/identity";
import { CryptographyClient } from "@azure/keyvault-keys";
import { BN } from "bn.js";

const asn1 = require("asn1.js") as any;

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
            `${keyVaultUrl}keys/privatekey`,
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
        const algorithm = "ECDSA256";
        // Create a new Transaction instance
        const tx = ethers.Transaction.from(transactionData);

        // Get the hash to sign - using the proper Ethereum transaction hash format
        const unsignedHash = ethers.keccak256(tx.unsignedSerialized);

        // Sign with Azure Key Vault
        const signature = await this.privateKeyClient.sign(
            algorithm,
            Buffer.from(unsignedHash.slice(2), "hex")
        );

        // Define ASN1 parser for DER signatures
        const ECDSASignature = asn1.define(
            "ECDSASignature",
            function (this: any) {
                this.seq().obj(this.key("r").int(), this.key("s").int());
            }
        );

        let parsedSig: any = {};
        if (signature.result.length >= 64) {
            parsedSig = {
                r: new BN(signature.result.slice(0, 32)),
                s: new BN(signature.result.slice(32, 64)),
            };
        }

        // Convert BN to hex strings with 0x prefix
        const r = "0x" + parsedSig.r.toString(16).padStart(64, "0");
        let s = "0x" + parsedSig.s.toString(16).padStart(64, "0");

        // Normalize 's' value (must be in lower half of curve for Ethereum)
        const secp256k1N = BigInt(
            "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"
        );
        const halfCurveOrder = secp256k1N / 2n;
        const sBigInt = BigInt(s);

        // Check if we need to normalize s
        if (sBigInt > halfCurveOrder) {
            s = "0x" + (secp256k1N - sBigInt).toString(16).padStart(64, "0");
        }

        // Get the chainId from transaction data
        const chainId = BigInt(transactionData.chainId);

        // Try recovery values in a methodical order
        const vOptions = [];

        // For post-EIP-155 transactions (most modern Ethereum transactions)
        if (chainId > 0n) {
            vOptions.push({
                v: Number(chainId * 2n + 35n),
                desc: "EIP-155 v0",
            });
            vOptions.push({
                v: Number(chainId * 2n + 36n),
                desc: "EIP-155 v1",
            });
        }

        // For legacy transactions (pre-EIP-155) - unlikely but included for completeness
        vOptions.push({ v: 27, desc: "Legacy v0" });
        vOptions.push({ v: 28, desc: "Legacy v1" });

        // Record all recovered addresses for debugging
        const recoveredAddresses = [];

        for (const vOption of vOptions) {
            // Create signature object
            const sig = {
                r,
                s,
                v: BigInt(vOption.v),
            };

            // Clone tx and apply signature
            const candidateTx = tx.clone();
            candidateTx.signature = sig;

            // Get recovered address
            const recoveredAddress = candidateTx.from;

            recoveredAddresses.push({
                v: vOption.v,
                recovered: recoveredAddress,
            });

            // Check if matches expected address
            if (
                recoveredAddress?.toLowerCase() ===
                Constants.METAMASK_ADDRESS.toLowerCase()
            ) {
                // Verify the transaction
                const serialized = candidateTx.serialized;
                const parsed = ethers.Transaction.from(serialized);

                if (
                    parsed.from?.toLowerCase() ===
                    Constants.METAMASK_ADDRESS.toLowerCase()
                ) {
                    return serialized;
                }
            }
        }

        throw new Error(
            `Could not find a valid signature recovering to ${Constants.METAMASK_ADDRESS}. 
             This may indicate an issue with the private key or signing process.
             Check the logs for detailed debugging information.`
        );
    }

    /**
     * Call this method to create a PEM file from a hex private key.
     * Then use the PEM file to import the key into Azure Key Vault by following the procedure below:
     *
     * # (in WSL) First check if your current key can be read by OpenSSL
     * openssl ec -inform PEM -in pkcs8_key.pem -text -noout
     *
     *  # (in WSL) If the above works, convert to named curve format
     * openssl ec -inform PEM -in pkcs8_key.pem -outform PEM -out named_curve_key.pem -param_enc named_curve
     *
     * # (in Windows) Try importing with the new file
     * az keyvault key import --vault-name liquidation \
     *                --name ethereum-signing-key \
     *                --pem-file named_curve_key.pem \
     *                --kty EC \
     *                --curve P-256K
     *
     * @param hexPrivateKey The private key of the wallet in hex format
     */
    public createPemFileFromPrivateKey(hexPrivateKey: string) {
        const fs = require("fs");
        const crypto = require("crypto");

        // Remove '0x' prefix if present
        const cleanHex = hexPrivateKey.startsWith("0x")
            ? hexPrivateKey.slice(2)
            : hexPrivateKey;

        // Convert to Buffer
        const privateKeyBuffer = Buffer.from(cleanHex, "hex");

        // Create EC key in the specific format Azure needs
        const ecPrivateKeyASN1 = Buffer.concat([
            // EC PRIVATE KEY header and length
            Buffer.from("302e", "hex"),
            // Version
            Buffer.from("0201", "hex"),
            Buffer.from("01", "hex"),
            // PrivKey header + length
            Buffer.from("0420", "hex"),
            privateKeyBuffer,
            // OID for secp256k1
            Buffer.from("a00706052b8104000a", "hex"),
        ]);

        // Convert to PEM format with EC-specific headers
        const pemKey =
            "-----BEGIN EC PRIVATE KEY-----\n" +
            (ecPrivateKeyASN1.toString("base64").match(/.{1,64}/g) || []).join(
                "\n"
            ) +
            "\n-----END EC PRIVATE KEY-----\n";

        // Write to file
        fs.writeFileSync("ec_key.pem", pemKey);
        console.log("EC Private key saved to ec_key.pem");
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
