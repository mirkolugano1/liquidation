import crypto from "crypto";

class Encryption {
    private static instance: Encryption;
    private constructor() {}

    public static getInstance(): Encryption {
        if (!Encryption.instance) {
            Encryption.instance = new Encryption();
        }
        return Encryption.instance;
    }

    async encrypt(
        stringToEncrypt: string,
        password: string = process.env.ENCRYPTION_PWD!
    ) {
        const key = crypto.createHash("sha256").update(password).digest();

        const iv = crypto.randomBytes(16); // Initialization Vector for AES-256-CBC
        const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
        const encrypted = Buffer.concat([
            iv,
            cipher.update(stringToEncrypt),
            cipher.final(),
        ]);
        return encrypted.toString("hex");
    }

    async decrypt(
        encryptedString: string,
        password: string = process.env.ENCRYPTION_PWD!
    ) {
        const key = crypto.createHash("sha256").update(password).digest();

        const iv = Buffer.from(encryptedString.slice(0, 32), "hex"); // Adjust slice length for 32-byte key
        const encryptedData = Buffer.from(encryptedString.slice(32), "hex");
        const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
        const decrypted = Buffer.concat([
            decipher.update(encryptedData),
            decipher.final(),
        ]);
        return decrypted.toString("utf8");
    }
}

export default Encryption.getInstance();
