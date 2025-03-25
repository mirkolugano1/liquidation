import _ from "lodash";
import dotenv from "dotenv";
import logger from "../shared/logger";
import healthFactorCheckEngine from "../engines/healthFactorCheckEngine";
import common from "../shared/common";
dotenv.config();

logger.initialize("sandbox", false);

async function main() {
    await logger.viewErrors();
    //await healthFactorCheckEngine.startCheckReservesPrices();
}

main();
