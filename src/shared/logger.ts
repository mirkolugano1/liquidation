import _ from "lodash";
import sqlManager from "../managers/sqlManager";
import { table } from "table";
import * as applicationInsights from "applicationinsights";
import { LoggingFramework, LogLevel, OutputType } from "../shared/enums";
import { InvocationContext } from "@azure/functions";
import moment from "moment";
import { TelemetryClient } from "applicationinsights";

class Logger {
    private internalLog: string = "";
    private clientAppName: string = "";
    private outputType: OutputType = OutputType.Console;
    public isInitialized: boolean = false;
    private applicationInsightsClient: TelemetryClient | null = null;
    private static instance: Logger;
    private context: InvocationContext | null = null;
    private constructor() {}

    initialize(
        clientAppName: string = "",
        context: InvocationContext | null = null
    ) {
        //this is to allow overriding the client app name
        if (!this.clientAppName || clientAppName) {
            this.clientAppName =
                clientAppName || process.env.LIQUIDATIONSERVERENVIRONMENT!;
        }

        if (this.isInitialized) return;
        this.isInitialized = true;
        this.context = context;

        applicationInsights
            .setup()
            .setAutoDependencyCorrelation(false)
            .setAutoCollectRequests(false)
            .setAutoCollectPerformance(false, false)
            .setAutoCollectExceptions(true)
            .setAutoCollectDependencies(false)
            .setAutoCollectConsole(false)
            .setUseDiskRetryCaching(false)
            .setSendLiveMetrics(false)
            .start();
        this.applicationInsightsClient = applicationInsights.defaultClient;
    }

    setOutputTypeConsole() {
        this.outputType = OutputType.Console;
    }

    setOutputTypeHTML() {
        this.outputType = OutputType.HTML;
    }

    async viewErrors(env: string = process.env.LIQUIDATIONENVIRONMENT!) {
        await this.viewLogs(LogLevel.Error, env);
    }

    async viewLogs(
        logLevel: LogLevel = LogLevel.Info,
        env: string = process.env.LIQUIDATIONENVIRONMENT!
    ) {
        const logLevelClause = logLevel
            ? `AND logLevel = '${logLevel.toString()}'`
            : "";
        const query = `SELECT TOP 100 * FROM dbo.logs WHERE env = @env ${logLevelClause} ORDER BY timestamp DESC`;
        let parameters: any = {
            env: env,
        };
        if (logLevel) {
            parameters["logLevel"] = logLevel.toString();
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

    appendToInternalLog(log: string) {
        this.internalLog += log + "\n";
    }

    async flushInternalLog(
        loggingFramework: LoggingFramework = LoggingFramework.Table
    ) {
        if (this.internalLog) {
            await this.log(this.internalLog, loggingFramework);
            this.internalLog = "";
        }
    }

    async trace(
        log: any,
        loggingFramework: LoggingFramework = LoggingFramework.ApplicationInsights
    ) {
        await this.log(log, loggingFramework, LogLevel.Trace);
    }

    async debug(
        log: any,
        loggingFramework: LoggingFramework = LoggingFramework.ApplicationInsights
    ) {
        await this.log(log, loggingFramework, LogLevel.Debug);
    }

    async info(
        log: any,
        loggingFramework: LoggingFramework = LoggingFramework.ApplicationInsights
    ) {
        await this.log(log, loggingFramework, LogLevel.Info);
    }

    async warning(
        log: any,
        loggingFramework: LoggingFramework = LoggingFramework.ApplicationInsights
    ) {
        await this.log(log, loggingFramework, LogLevel.Warning);
    }

    async error(
        log: any,
        loggingFramework: LoggingFramework = LoggingFramework.ApplicationInsights
    ) {
        return await this.log(log, loggingFramework, LogLevel.Error);
    }

    async log(
        log: any | Error,
        loggingFramework: LoggingFramework = LoggingFramework.ApplicationInsights,
        logLevel: LogLevel = LogLevel.Info
    ) {
        this.initialize(
            process.env.LIQUIDATIONSERVERENVIRONMENT!,
            this.context
        );
        console.log("### Log entry ###", log);

        // Application Insights logging
        if (loggingFramework === LoggingFramework.ApplicationInsights) {
            if (!this.applicationInsightsClient) {
                throw new Error("Application Insights client not initialized");
            }

            if (this.context) {
                const aiParameters = {
                    log: typeof log === "string" ? log : JSON.stringify(log),
                    env: process.env.LIQUIDATIONENVIRONMENT,
                    clientAppName: this.clientAppName,
                };

                switch (logLevel) {
                    case LogLevel.Trace:
                        this.context.trace(aiParameters);
                        break;
                    case LogLevel.Debug:
                        this.context.debug(aiParameters);
                        break;
                    case LogLevel.Info:
                        this.context.info(aiParameters);
                        break;
                    case LogLevel.Warning:
                        this.context.warn(aiParameters);
                        break;
                    case LogLevel.Error:
                        this.context.error(aiParameters);
                        break;
                }
            } else {
                const _log =
                    typeof log === "string" ? log : JSON.stringify(log);
                const aiParameters = {
                    env: process.env.LIQUIDATIONENVIRONMENT,
                    clientAppName: this.clientAppName,
                };

                switch (logLevel) {
                    case LogLevel.Trace:
                    case LogLevel.Debug:
                    case LogLevel.Info:
                    case LogLevel.Warning:
                        this.applicationInsightsClient.trackTrace({
                            message: _log,
                            properties: aiParameters,
                        });
                        break;
                    case LogLevel.Error:
                        this.applicationInsightsClient.trackException({
                            exception: new Error(_log),
                            properties: aiParameters,
                        });
                        break;
                }
            }
        } else {
            const dbParameters = {
                logLevel: logLevel.toString(),
                timestamp: moment.utc().format("YYYY-MM-DD HH:mm:ss"),
                log: typeof log === "string" ? log : JSON.stringify(log), // Keep raw log if it's an object
                env: process.env.LIQUIDATIONENVIRONMENT,
                clientAppName: this.clientAppName,
            };

            // Database logging
            const query = `
                INSERT INTO dbo.logs (timestamp, log, logLevel, env, clientAppName)
                VALUES (@timestamp, @log, @logLevel, @env, @clientAppName)
            `;
            await sqlManager.execQuery(query, dbParameters);
        }
    }

    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }
}

export default Logger.getInstance();
