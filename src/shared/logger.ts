import _ from "lodash";
import sqlManager from "../managers/sqlManager";
import { table } from "table";

class Logger {
    private clientAppName: string = "";
    private outputType: string = "console";
    private isInitialized: boolean = false;
    private static instance: Logger;
    private constructor() {}

    initialize(clientAppName: string, shouldSetupErrorHandler: boolean = true) {
        if (this.isInitialized) return;
        this.isInitialized = true;
        this.clientAppName = clientAppName;
        if (shouldSetupErrorHandler) this.initializeErrorHandler();
    }

    initializeErrorHandler() {
        process.on("uncaughtException", async (error: Error) => {
            await this.logError({
                error: error.message,
                stack: error.stack,
            });

            process.exit(1);
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

                process.exit(1);
            }
        );
    }

    setOutputTypeConsole() {
        this.outputType = "console";
    }

    setOutputTypeHTML() {
        this.outputType = "HTML";
    }

    async deleteOldLogs() {
        const query = `DELETE FROM dbo.logs WHERE timestamp < DATEADD(DAY, -3, GETDATE())`;
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
        const headers = Object.keys(data[0]);
        const headersUpper = _.map(headers, (header) => header?.toUpperCase());
        const rows = data.map((obj) =>
            headers.map(
                (header) => obj[header]?.toString().substring(0, 50) || ""
            )
        );

        return this.outputType === "console"
            ? this.viewDataAsConsoleTable(headersUpper, rows)
            : this.viewDataAsHTMLTable(headersUpper, rows);
    }

    viewDataAsHTMLTable(headers: string[], rows: any[][]): string {
        let table = '<table border="1"><thead><tr>';
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

    async log(log: any, logLevel: string = "info") {
        if (typeof log !== "string") {
            log = JSON.stringify(log);
        }
        const date = new Date();
        const query = `INSERT INTO dbo.logs (timestamp, log, logLevel, env, clientappname) VALUES (@timestamp, @log, @logLevel, @env, @clientAppName)`;
        const parameters = {
            timestamp: date,
            log: log,
            logLevel: logLevel,
            env: process.env.LIQUIDATIONENVIRONMENT,
            clientAppName: this.clientAppName,
        };

        console.log("Logger", parameters);

        await sqlManager.execQuery(query, parameters);
    }

    public static getInstance(): Logger {
        if (!Logger.instance) {
            Logger.instance = new Logger();
        }
        return Logger.instance;
    }
}

export default Logger.getInstance();
