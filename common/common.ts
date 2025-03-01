import _ from "lodash";
import fileUtilities from "./fileUtilities";
import encryption from "./encryption";

require("@azure/opentelemetry-instrumentation-azure-sdk");
require("@azure/core-tracing");

class Common {
    public addressesFilePath = "/home/data/addresses.txt";
    public appInsights: any = null;
    public isProd: boolean = false;
    private static instance: Common;
    private constructor() {
        this.isProd =
            process.env.LIQUIDATIONENVIRONMENT?.toLowerCase() == "prod";

        this.isProd = true;
        /*
        if (this.isProd) {
            const appInsights = require("applicationinsights");

            // Replace with your Application Insights Instrumentation Key
            appInsights
                .setup(process.env.APPLICATIONINSIGHTSINSTRUMENTATIONKEY)
                .setAutoCollectExceptions(true)
                .start();

            this.appInsights = appInsights.defaultClient;
        }
        */
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

    public static getInstance(): Common {
        if (!Common.instance) {
            Common.instance = new Common();
        }
        return Common.instance;
    }

    async checkRequiredEnvironmentVariables(
        requiredEnvironmentVariables: string[]
    ) {
        for (let key of requiredEnvironmentVariables) {
            if (!(await this.getAppSetting(key))) {
                throw new Error("Missing required environment variable " + key);
            }
        }
    }

    async log(str: string, severity: string = "Information") {
        console.log(str);
        /*
        if (this.isProd) {
            let trackType: string;
            switch (severity) {
                case "Verbose":
                case "Information":
                case "Debug":
                case "Warning":
                case "Error":
                case "Critical":
                    break;
                default:
                    throw new Error(
                        "Common.log: Wrong severity type: " + severity
                    );
            }
            const appInsightsSeverity = severity;
            this.appInsights.trackTrace({
                message: str,
                severity: appInsightsSeverity,
            });
        }
            */
    }
}

export default Common.getInstance();
