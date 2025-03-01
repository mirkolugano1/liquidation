import common from "../common/common";
import encryption from "../common/encryption";

const sql = require("mssql");
require("dotenv").config();

class SqlManager {
    private static instance: SqlManager;
    private static databaseName: string = "liquidation";
    private static config: any;

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
        SqlManager.config = {
            user: await common.getAppSetting("SQLUSER"),
            password: decryptedSqlPassword,
            server: await common.getAppSetting("SQLSERVER"),
            database: SqlManager.databaseName,
            options: {
                encrypt: true,
                trustServerCertificate: false,
            },
        };
    }

    async execQuery(query: string) {
        if (!SqlManager.config) await this.initialize();
        try {
            await sql.connect(SqlManager.config);
            const result = await sql.query(query);
            return result?.recordset;
        } catch (err) {
            console.error("SQL error:", err);
        } finally {
            sql.close();
        }
    }
}

export default SqlManager.getInstance();
