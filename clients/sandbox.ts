import { CloudStorageManager } from "../managers/cloudStorageManager";
import common from "../common/common";
import sqlManager from "../managers/sqlManager";
import encryption from "../common/encryption";
import fileUtilities from "../common/fileUtilities";
import keccak from "../common/keccak";
import healthFactorCheckEngine from "../engines/healthFactorCheckEngine";
import webhookEngine from "../engines/webhookEngine";
import _, { add, forEach } from "lodash";
import dotenv from "dotenv";
import { ethers } from "ethers";
dotenv.config();

async function main() {
    await healthFactorCheckEngine.getReservesPrices("arb");
    //await healthFactorCheckEngine.periodicalAccountsHealthFactorAndConfigurationCheck();
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("Error:", error);
        process.exit(1);
    })
    .finally(() => process.exit(0));
