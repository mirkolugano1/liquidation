import _ from "lodash";
import fileUtilities from "./fileUtilities";

class Common {
    private static instance: Common;
    private constructor() {}

    public static getInstance(): Common {
        if (!Common.instance) {
            Common.instance = new Common();
        }
        return Common.instance;
    }

    requiredEnvironmentVariables: string[] = [
        "ENCRYPTION_PWD",
        "PRIVATE_KEY_ENCRYPTED",
        "ALCHEMY_KEY_ENCRYPTED",
        "LIQUIDATION_ENVIRONMENT",
    ];

    checkRequiredEnvironmentVariables() {
        for (let key of this.requiredEnvironmentVariables) {
            if (!process.env.hasOwnProperty(key) || !_.trim(process.env[key])) {
                throw new Error("Missing required environment variable " + key);
            }
        }
    }

    async log(str: string) {
        if (process.env.LIQUIDATION_ENVIRONMENT == "prod") {
            //TODO log data in the cloud
        } else {
            console.log(str);
            await fileUtilities.appendToTextFile("./log.txt", str + "\n");
        }
    }

    async loadData(source: string): Promise<string | undefined> {
        if (process.env.LIQUIDATION_ENVIRONMENT == "prod") {
            //TODO fetch data from a cloud DB
        } else {
            return await fileUtilities.readFromTextFile(source);
        }
        return "";
    }

    async saveData(dest: string, str: string) {
        if (process.env.LIQUIDATION_ENVIRONMENT == "prod") {
            //TODO save data to a cloud DB
        } else {
            await fileUtilities.appendToTextFile(dest, str);
        }
    }
}

export default Common.getInstance();
