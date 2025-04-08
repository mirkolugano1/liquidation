import healthFactorCheckEngine from "../engines/healthFactorCheckEngine";
import { app } from "@azure/functions";
import logger from "../shared/logger";

app.timer("testFunction", {
    schedule: "0 0 * * *", // Cron expression for every x hours
    handler: async (myTimer, context) => {
        await healthFactorCheckEngine.testFunction(context);
    },
});

app.timer("deleteOldTableLogsFunction", {
    schedule: "5 0 * * *", // Cron expression for every day at midnight
    handler: async (myTimer, context) => {
        await logger.deleteOldTableLogs(context);
    },
});

app.timer("updateReservesData", {
    schedule: "10 0 * * *", // Cron expression for every day at 00:10 h
    handler: async (myTimer, context) => {
        await healthFactorCheckEngine.updateReservesData(context);
    },
});

app.timer("updateHealthFactorAndUserConfiguration", {
    schedule: "15 0 * * *", // Cron expression for every day at 00:10 h
    handler: async (myTimer, context) => {
        await healthFactorCheckEngine.updateHealthFactorAndUserConfiguration(
            context
        );
    },
});

app.timer("updateTokenPricesWrapperFunction", {
    schedule: "20 0 * * *", // Cron expression for every day at 00:10 h
    handler: async (myTimer, context) => {
        await healthFactorCheckEngine.updateTokenPricesWrapperFunction(context);
    },
});
