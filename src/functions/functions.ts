import engine from "../engines/engine";
import { app } from "@azure/functions";

app.timer("updateGasPrice", {
    schedule: "0 0 * * *", // Cron expression for every day at 00:10 h
    handler: async (myTimer, context) => {
        await engine.updateGasPrice(context);
    },
});

app.timer("deleteOldTablesEntriesFunction", {
    schedule: "1 0 * * *", // Cron expression for every day at midnight
    handler: async (myTimer, context) => {
        await engine.deleteOldTablesEntries(context);
    },
});

app.timer("updateReservesData", {
    schedule: "5 0 * * *", // Cron expression for every day at 00:10 h
    handler: async (myTimer, context) => {
        await engine.updateReservesData(context);
    },
});
/*
app.timer("updateUserAccountDataAndUserReserves", {
    schedule: "10 0 * * *", // Cron expression for every day at 00:10 h
    handler: async (myTimer, context) => {
        await engine.updateUserAccountDataAndUsersReserves(context);
    },
});
*/
app.timer("updateReservesPrices", {
    schedule: "15 0 * * *", // Cron expression for every day at 00:10 h
    handler: async (myTimer, context) => {
        await engine.updateReservesPrices(context);
    },
});

engine.setCloseEvent();
