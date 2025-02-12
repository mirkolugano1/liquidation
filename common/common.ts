import _ from "lodash";
import fileUtilities from "./fileUtilities";

require("@azure/opentelemetry-instrumentation-azure-sdk");
require("@azure/core-tracing");

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
                .setup(process.env.APPLICATIONINSIGHTS_CONNECTION_STRING)
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
        console.log(str);
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
        }
    }
}

export default Common.getInstance();
