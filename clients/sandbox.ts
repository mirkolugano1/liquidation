import { CloudStorageManager } from "../common/cloudStorageManager";
import common from "../common/common";
import encryption from "../common/encryption";
import fileUtilities from "../common/fileUtilities";
import keccak from "../common/keccak";
import healthFactorCheckEngine from "../engines/healthFactorCheckEngine";
require("dotenv").config();

async function main() {
    await healthFactorCheckEngine.initializeHealthFactorCheckLoop();
    await healthFactorCheckEngine.performHealthFactorCheckLoop();
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("Error:", error);
        process.exit(1);
    });
