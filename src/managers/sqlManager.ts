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

    public static getInstance(): SqlManager {
        if (!SqlManager.instance) {
            SqlManager.instance = new SqlManager();
        }
        return SqlManager.instance;
    }

    async initialize() {
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
    }

    async execQuery(query: string, parameters: Record<string, any> = {}) {
        if (!this.config) await this.initialize();
        let pool;
        try {
            pool = await sql.connect(this.config);

            const request = pool.request();

            // Add all parameters
            Object.entries(parameters).forEach(([paramName, paramValue]) => {
                // Automatically determine parameter type based on value type
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
                    // Default to NVarChar for strings and other types
                    request.input(paramName, sql.NVarChar, paramValue);
                }
            });

            const result = await request.query(query);
            return result?.recordset;
        } finally {
            if (pool) await pool.close();
        }
    }
}

export default SqlManager.getInstance();
