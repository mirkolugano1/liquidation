import _ from "lodash";
import sqlManager from "../managers/sqlManager";
import { table } from "table";
import * as applicationInsights from "applicationinsights";

class Logger {
    private clientAppName: string = "";
    private loggingFramework: LoggingFramework =
        LoggingFramework.ApplicationInsights;
    private outputType: OutputType = OutputType.Console;
    private isInitialized: boolean = false;
    private applicationInsightsClient: any = null;
    private static instance: Logger;
    private constructor() {}

    initialize(
        clientAppName: string,
        loggingFramework: LoggingFramework = LoggingFramework.ApplicationInsights
    ) {
        if (this.isInitialized) return;
        this.isInitialized = true;
        this.clientAppName = clientAppName;

        applicationInsights
            .setup()
            .setAutoDependencyCorrelation(true)
            .setAutoCollectRequests(true)
            .setAutoCollectPerformance(true, true)
            .setAutoCollectExceptions(true)
            .setAutoCollectDependencies(true)
            .setAutoCollectConsole(true)
            .setUseDiskRetryCaching(true)
            .setSendLiveMetrics(false)
            .start();
        this.applicationInsightsClient = applicationInsights.defaultClient;

        process.on("beforeExit", () => {
            // Flush any remaining telemetry data before the application exits
            this.applicationInsightsClient.flush({
                callback: (response: any) => {
                    console.log("Telemetry data flushed successfully.");
                },
            });
        });

        this.loggingFramework = loggingFramework;
        if (loggingFramework === LoggingFramework.Table)
            this.initializeErrorHandler();
    }

    errorHandlerInitialized: boolean = false;

    initializeErrorHandler() {
        if (this.errorHandlerInitialized) return;
        if (this.loggingFramework === LoggingFramework.Table) {
            process.on("uncaughtException", async (error: Error) => {
                await this.logError({
                    error: error.message,
                    stack: error.stack,
                });
            });

            // Unhandled Promise Rejection Handler
            process.on(
                "unhandledRejection",
                async (reason: any, promise: Promise<any>) => {
                    await this.logError({
                        reason:
                            reason instanceof Error
                                ? reason.message
                                : String(reason),
                        stack:
                            reason instanceof Error
                                ? reason.stack
                                : "No stack trace available",
                    });
                }
            );

            this.errorHandlerInitialized = true;
        }
    }

    useTableLogging() {
        this.loggingFramework = LoggingFramework.Table;
        this.initializeErrorHandler();
    }

    useApplicationInsightsLogging() {
        this.loggingFramework = LoggingFramework.ApplicationInsights;
    }

    setOutputTypeConsole() {
        this.outputType = OutputType.Console;
    }

    setOutputTypeHTML() {
        this.outputType = OutputType.HTML;
    }

    async deleteOldLogs() {
        const query = `DELETE FROM dbo.logs WHERE timestamp < DATEADD(DAY, -2, GETDATE())`;
        await sqlManager.execQuery(query);
    }

    async getLogLevels() {
        const query = `SELECT DISTINCT loglevel FROM dbo.logs`;
        const data = await sqlManager.execQuery(query);
        this.viewDataAsTable(data);
    }

    async viewErrors(env: string = process.env.LIQUIDATIONENVIRONMENT!) {
        await this.viewLogs("error", env);
    }

    async viewLogById(id: number) {
        const query = `SELECT * FROM dbo.logs WHERE id = @id`;
        const data = await sqlManager.execQuery(query, { id: id });
        console.log(data);
    }

    async viewLogs(
        logLevel: string = "",
        env: string = process.env.LIQUIDATIONENVIRONMENT!
    ) {
        const logLevelClause = logLevel ? `AND logLevel = '${logLevel}'` : "";
        const query = `SELECT TOP 100 * FROM dbo.logs WHERE env = @env ${logLevelClause} ORDER BY timestamp DESC`;
        let parameters: any = {
            env: env,
        };
        if (logLevel) {
            parameters["logLevel"] = logLevel;
        }
        const data = await sqlManager.execQuery(query, parameters);
        _.each(data, (log) => {
            log.timestamp = log.timestamp.toISOString();
        });
        return this.viewDataAsTable(data);
    }

    viewDataAsConsoleTable(headers: any[], rows: any[][]) {
        const output = table([headers, ...rows]);
        console.log(output);
    }

    viewDataAsTable(data: any[]) {
        const isOutputTypeConsole = this.outputType === OutputType.Console;
        const headers = Object.keys(data[0]);
        const headersUpper = _.map(headers, (header) => header?.toUpperCase());
        const rows = data.map((obj) =>
            headers.map(
                (header) =>
                    (isOutputTypeConsole
                        ? obj[header]?.toString().substring(0, 50)
                        : obj[header]?.toString()) || ""
            )
        );

        return isOutputTypeConsole
            ? this.viewDataAsConsoleTable(headersUpper, rows)
            : this.viewDataAsHTMLTable(headersUpper, rows);
    }

    viewDataAsHTMLTable(headers: string[], rows: any[][]): string {
        let table = '<table border="1" style="padding: 5px;"><thead><tr>';
        headers.forEach((header) => {
            table += `<th>${header}</th>`;
        });
        table += "</tr></thead><tbody>";

        rows.forEach((row) => {
            table += "<tr>";
            row.forEach((cell) => {
                table += `<td>${cell}</td>`;
            });
            table += "</tr>";
        });

        table += "</tbody></table>";
        return table;
    }

    async logError(log: any) {
        await this.log(log, "error");
    }

    async logEvent(
        log: any,
        logLevel: string = "info",
        loggingFramework: LoggingFramework = LoggingFramework.ApplicationInsights
    ) {
        await this.log(log, logLevel, loggingFramework, LogType.Event);
    }

    async logToTable(
        log: any,
        logLevel: string = "info",
        logType: LogType = LogType.Trace
    ) {
        await this.log(log, logLevel, LoggingFramework.Table, logType);
    }

    async log(
        log: any,
        logLevel: string = "info",
        loggingFramework: LoggingFramework = LoggingFramework.ApplicationInsights,
        logType: LogType = LogType.Trace
    ) {
        if (typeof log !== "string") {
            log = JSON.stringify(log);
        }
        const date = new Date();
        const parameters = {
            timestamp: date,
            log: log,
            logLevel: logLevel,
            env: process.env.LIQUIDATIONENVIRONMENT,
            clientAppName: this.clientAppName,
        };

        console.log("Logger", parameters);

        if (
            loggingFramework == LoggingFramework.ApplicationInsights ||
            this.loggingFramework === LoggingFramework.ApplicationInsights
        ) {
            if (logType === LogType.Event) {
                this.applicationInsightsClient.trackEvent({
                    name: logLevel,
                    properties: parameters,
                });
            } else {
                this.applicationInsightsClient.trackTrace({
                    message: logLevel,
                    properties: parameters,
                });
            }
        } else {
            const query = `INSERT INTO dbo.logs (timestamp, log, logLevel, env, clientappname) VALUES (@timestamp, @log, @logLevel, @env, @clientAppName)`;
            await sqlManager.execQuery(query, parameters);
        }
    }

    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }
}

enum LogType {
    Event,
    Trace,
}

enum LoggingFramework {
    Table,
    ApplicationInsights,
}

enum OutputType {
    Console,
    HTML,
}

export default Logger.getInstance();
