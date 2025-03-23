import { CloudStorageManager } from "../managers/cloudStorageManager";
import common from "../common/common";
import sqlManager from "../managers/sqlManager";
import encryption from "../common/encryption";
import fileUtilities from "../common/fileUtilities";
import healthFactorCheckEngine from "../engines/healthFactorCheckEngine";
import webhookEngine from "../engines/webhookEngine";
import _, { add, forEach } from "lodash";
import dotenv from "dotenv";
import { ethers } from "ethers";
dotenv.config();

async function main() {
    console.log("aa");
    //await healthFactorCheckEngine.checkReservesPrices("arb");
    //await healthFactorCheckEngine.periodicalAccountsHealthFactorAndConfigurationCheck();
    process.exit(0);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("Error:", error);
        process.exit(1);
    })
    .finally(() => process.exit(0));
