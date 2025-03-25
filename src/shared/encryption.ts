import crypto from "crypto";
import common from "./common";

import { SecretClient } from "@azure/keyvault-secrets";
import { DefaultAzureCredential } from "@azure/identity";

class Encryption {
    private static keyVaultUrl = "https://liquidation.vault.azure.net/";
    private static encryptionPassword: string = "";
    private static instance: Encryption;
    private static credential: any;
    private static secretClient: any;
    private constructor() {}

    public static getInstance(): Encryption {
        if (!Encryption.instance) {
            Encryption.instance = new Encryption();
            Encryption.credential = new DefaultAzureCredential();
            Encryption.secretClient = new SecretClient(
                Encryption.keyVaultUrl,
                Encryption.credential
            );
        }
        return Encryption.instance;
    }

    async ensureEncryptionPassword() {
        if (!Encryption.encryptionPassword) {
            Encryption.encryptionPassword = await common.getAppSetting(
                "ENCRYPTIONPWD"
            );
            if (!Encryption.encryptionPassword) {
                throw new Error("Encryption password not found in Key Vault");
            }
        }
    }

    async encrypt(stringToEncrypt: string) {
        await this.ensureEncryptionPassword();
        const key = crypto
            .createHash("sha256")
            .update(Encryption.encryptionPassword)
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
            .update(Encryption.encryptionPassword)
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

    async getSecretFromKeyVault(key: string) {
        try {
            const secret = await Encryption.secretClient.getSecret(key);
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

export default Encryption.getInstance();
