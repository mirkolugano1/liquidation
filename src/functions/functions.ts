import healthFactorCheckEngine from "../engines/healthFactorCheckEngine";
import { app } from "@azure/functions";

app.timer("testFunction", {
    schedule: "0 */5 * * * *", // Cron expression for every 5 minutes
    handler: async (myTimer, context) => {
        await healthFactorCheckEngine.testFunction(context);
    },
});
