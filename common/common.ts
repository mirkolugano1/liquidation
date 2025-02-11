import _ from "lodash";
import fileUtilities from "./fileUtilities";

class Common {
    public appInsights: any = null;
    public isProd: boolean = false;
    private static instance: Common;
    private constructor() {
        this.isProd =
            process.env.LIQUIDATIONENVIRONMENT?.toLowerCase() == "prod";
        if (this.isProd) {
            const appInsights = require("applicationinsights");

            // Replace with your Application Insights Instrumentation Key
            appInsights
                .setup(process.env.APPLICATIONINSIGHTSINSTRUMENTATIONKEY)
                .setAutoCollectExceptions(true)
                .start();

            this.appInsights = appInsights.defaultClient;
        }
    }

    public static getInstance(): Common {
        if (!Common.instance) {
            Common.instance = new Common();
        }
        return Common.instance;
    }

    checkRequiredEnvironmentVariables(requiredEnvironmentVariables: string[]) {
        for (let key of requiredEnvironmentVariables) {
            if (!process.env.hasOwnProperty(key) || !_.trim(process.env[key])) {
                throw new Error("Missing required environment variable " + key);
            }
        }
    }

    async log(str: string, severity: string = "Information") {
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
            const appInsightsSeverity =
                this.appInsights.Contracts.SeverityLevel[severity];
            this.appInsights.trackTrace({
                message: str,
                severity: appInsightsSeverity,
            });
        } else {
            console.log(str);
            await fileUtilities.appendToTextFile("./data/log.txt", str + "\n");
        }
    }

    async loadData(source: string): Promise<string | undefined> {
        if (this.isProd) {
            //TODO fetch data from cloud storage blob
        } else {
            return await fileUtilities.readFromTextFile(source);
        }
        return "";
    }

    async saveData(dest: string, str: string) {
        if (this.isProd) {
            //TODO save data to cloud storage blob
        } else {
            await fileUtilities.appendToTextFile(dest, str);
        }
    }
}

export default Common.getInstance();
