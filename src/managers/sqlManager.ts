import common from "../shared/common";
import encryption from "../shared/encryption";
import sql from "mssql";

import dotenv from "dotenv";
dotenv.config();

class SqlManager {
    private static instance: SqlManager;
    private databaseName: string = "liquidation";
    private sqlServerName: string = "liquidation.database.windows.net";
    private config: any;
    private pool: sql.ConnectionPool | null = null;

    public static getInstance(): SqlManager {
        if (!SqlManager.instance) {
            SqlManager.instance = new SqlManager();
        }
        return SqlManager.instance;
    }

    private async initialize() {
        const encryptedSqlPassword = await common.getAppSetting(
            "SQLPASSWORDENCRYPTED"
        );
        const decryptedSqlPassword = await encryption.decrypt(
            encryptedSqlPassword
        );
        const encryptedSqlUser = await common.getAppSetting("SQLUSERENCRYPTED");
        const decryptedSqlUser = await encryption.decrypt(encryptedSqlUser);

        this.config = {
            user: decryptedSqlUser,
            password: decryptedSqlPassword,
            server: this.sqlServerName,
            database: this.databaseName,
            options: {
                encrypt: true,
                trustServerCertificate: false,
            },
        };

        // Create a single connection pool
        this.pool = new sql.ConnectionPool(this.config);

        // Connect and handle errors
        this.pool.on("error", (err) => {
            console.error("SQL Pool Error:", err);
        });

        await this.pool.connect();
    }

    private async getPool() {
        if (!this.pool || !this.pool.connected) {
            await this.initialize();
        }
        return this.pool;
    }

    getBitFromBoolean(value: boolean): number {
        return value ? 1 : 0;
    }

    async execQuery(query: string, parameters: Record<string, any> = {}) {
        const pool = await this.getPool();
        if (!pool) throw new Error("No connection pool available.");

        try {
            const request = pool.request();

            // Add all parameters
            Object.entries(parameters).forEach(([paramName, paramValue]) => {
                if (paramValue === null) {
                    request.input(paramName, paramValue);
                } else if (typeof paramValue === "number") {
                    if (Number.isInteger(paramValue)) {
                        request.input(paramName, sql.Int, paramValue);
                    } else {
                        request.input(paramName, sql.Float, paramValue);
                    }
                } else if (typeof paramValue === "boolean") {
                    request.input(paramName, sql.Bit, paramValue);
                } else if (paramValue instanceof Date) {
                    request.input(paramName, sql.DateTime, paramValue);
                } else {
                    request.input(paramName, sql.NVarChar, paramValue);
                }
            });

            const result = await request.query(query);
            return result?.recordset;
        } catch (error) {
            console.error("SQL Query Error:", error);
            throw error;
        }
    }

    async closePool() {
        if (this.pool) {
            await this.pool.close();
            this.pool = null;
        }
    }
}

export default SqlManager.getInstance();
