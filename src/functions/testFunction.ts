import healthFactorCheckEngine from "../engines/healthFactorCheckEngine";
import dotenv from "dotenv";
import logger from "../shared/logger";
dotenv.config();

import { app, Timer } from "@azure/functions";

async function testFunction(myTimet: Timer): Promise<void> {
    logger.initialize("function:testJob");
    await healthFactorCheckEngine.testJob();
}

app.timer("testFunction", {
    schedule: "0 */5 * * * *", // Cron expression for every 5 minutes
    handler: testFunction,
});

/*
async function main() {
    logger.initialize("webJob:testJob");
    await healthFactorCheckEngine.testJob();
    return;

    const args = process.argv;
    if (args.length < 3)
        throw new Error("Must define function to be executed.");
    const job = args[2];

    logger.initialize("webJob:" + job);
    switch (job) {
        case "testJob":
            await healthFactorCheckEngine.testJob();
            break;

        case "startCheckReservesPrices":
            await healthFactorCheckEngine.startCheckReservesPrices();
            break;

        case "deleteOldLogs":
            await logger.deleteOldLogs();
            break;

        default:
            throw new Error("Invalid function to be executed.");
    }
}

main();
*/
