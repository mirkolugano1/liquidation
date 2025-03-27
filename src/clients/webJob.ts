import healthFactorCheckEngine from "../engines/healthFactorCheckEngine";
import dotenv from "dotenv";
import logger from "../shared/logger";
dotenv.config();

logger.initialize("webJob");

async function main() {
    const args = process.argv;
    if (args.length < 3)
        throw new Error("Must define function to be executed.");
    const job = args[2];

    switch (job) {
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
