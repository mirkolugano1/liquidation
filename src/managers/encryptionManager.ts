import crypto from "crypto";
import common from "../shared/common";

import { SecretClient } from "@azure/keyvault-secrets";
import { DefaultAzureCredential } from "@azure/identity";
import { CryptographyClient } from "@azure/keyvault-keys";

class EncryptionManager {
    private static instance: EncryptionManager;

    private encryptionPassword: string = "";
    private secretClient: any;
    private cryptoClient: any;

    private constructor() {
        const keyVaultUrl = "https://liquidation.vault.azure.net/";
        const credential = new DefaultAzureCredential();
        this.secretClient = new SecretClient(keyVaultUrl, credential);
        this.cryptoClient = new CryptographyClient(
            `${keyVaultUrl}keys/liquidationkey`,
            credential
        );
    }

    public static getInstance(): EncryptionManager {
        if (!EncryptionManager.instance) {
            EncryptionManager.instance = new EncryptionManager();
        }
        return EncryptionManager.instance;
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
