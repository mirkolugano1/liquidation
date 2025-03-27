import _ from "lodash";
import encryption from "./encryption";

class Common {
    public isProd: boolean;
    private static instance: Common;
    private constructor() {
        this.isProd =
            process.env.LIQUIDATIONENVIRONMENT?.toLowerCase() == "prod";
    }

    keyVaultEntries: string[] = [
        "SQLUSERENCRYPTED",
        "SQLPASSWORDENCRYPTED",
        "ENCRYPTIONPWD",
        "ALCHEMYKEYENCRYPTED",
        "PRIVATEKEYENCRYPTED",
        "CLOUDSTORAGEKEYENCRYPTED",
    ];

    public async getAppSetting(key: string) {
        if (_.includes(this.keyVaultEntries, key)) {
            return await encryption.getSecretFromKeyVault(key);
        }

        if (!process.env.hasOwnProperty(key)) {
            throw new Error("Missing required environment variable " + key);
        }
        return process.env[key];
    }

    public intToBinary(integerValue: any) {
        return integerValue.toString(2);
    }

    public async sleep(ms: number) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    public static getInstance(): Common {
        if (!Common.instance) {
            Common.instance = new Common();
        }
        return Common.instance;
    }
}

export default Common.getInstance();
