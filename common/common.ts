import _ from "lodash";
import encryption from "./encryption";
import fileUtilities from "./fileUtilities";

class Common {
    public addressesFilePath = "/home/data/addresses.txt";
    public appInsights: any = null;
    public isProd: boolean = false;
    private static instance: Common;
    private constructor() {
        this.isProd =
            process.env.LIQUIDATIONENVIRONMENT?.toLowerCase() == "prod";

        this.isProd = true;
    }

    keyVaultEntries: string[] = [
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

    public async getAaveChainsInfos() {
        const contents = await fileUtilities.readFromTextFile(
            "json/aaveChainsInfos.json"
        );
        return JSON.parse(contents);
    }

    public static getInstance(): Common {
        if (!Common.instance) {
            Common.instance = new Common();
        }
        return Common.instance;
    }
}

export default Common.getInstance();
