import healthFactorCheckEngine from "../engines/healthFactorCheckEngine";
import { app } from "@azure/functions";
import logger from "../shared/logger";

app.timer("testFunction", {
    schedule: "0 */6 * * *", // Cron expression for every x hours
    handler: async (myTimer, context) => {
        await healthFactorCheckEngine.testFunction(context);
    },
});

app.timer("deleteOldTableLogsFunction", {
    schedule: "0 0 * * *", // Cron expression for every day at midnight
    handler: async (myTimer, context) => {
        await logger.deleteOldTableLogs(context);
    },
});
