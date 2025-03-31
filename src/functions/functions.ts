import healthFactorCheckEngine from "../engines/healthFactorCheckEngine";
import { app, Timer, InvocationContext } from "@azure/functions";

async function testFunction(
    timer: Timer,
    context: InvocationContext
): Promise<void> {
    await healthFactorCheckEngine.testFunction(context);
}

app.timer("testFunction", {
    schedule: "0 */5 * * * *", // Cron expression for every 5 minutes
    handler: testFunction,
});
