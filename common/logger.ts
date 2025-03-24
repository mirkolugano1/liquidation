import sqlManager from "../managers/sqlManager.js";

class Logger {
    private static instance: Logger;
    private constructor() {}

    async log(logText: string, logLevel: string = "info") {
        const date = new Date();
        const query = `INSERT INTO dbo.logs (timestamp, log, logLevel, env) VALUES (@timestamp, @log, @logLevel, @env)`;
        const parameters = {
            timestamp: date,
            log: logText,
            logLevel: logLevel,
            env: process.env.LIQUIDATIONENVIRONMENT,
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
