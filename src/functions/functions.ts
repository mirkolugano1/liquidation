import engine from "../engines/engine";
import { app } from "@azure/functions";

app.timer("deleteOldTableLogsFunction", {
    schedule: "5 0 * * *", // Cron expression for every day at midnight
    handler: async (myTimer, context) => {
        await engine.deleteOldTableLogs(context);
    },
});

app.timer("updateReservesData", {
    schedule: "10 0 * * *", // Cron expression for every day at 00:10 h
    handler: async (myTimer, context) => {
        await engine.updateReservesData(context);
    },
});

app.timer("updateUserAccountDataAndUserReserves", {
    schedule: "15 0 * * *", // Cron expression for every day at 00:10 h
    handler: async (myTimer, context) => {
        await engine.updateUserAccountDataAndUserReserves(context);
    },
});

app.timer("updateTokensPrices", {
    schedule: "20 0 * * *", // Cron expression for every day at 00:10 h
    handler: async (myTimer, context) => {
        await engine.updateTokensPrices(context);
    },
});
