/*
REQUIRED ENVIRONMENT VARIABLES:
- PRIVATE_KEY_ENCRYPTED: Encrypted private key from Metamask
- ALCHEMY_KEY_ENCRYPTED: Encrypted Alchemy key
- ENCRYPTION_PWD: Encryption password
- LIQUIDATION_ENVIRONMENT: dev/test/prod
*/

//Imports
import healthFactorCheckEngine from "../engines/healthFactorCheckEngine";
import common from "../common/common";
require("dotenv").config();

//Main function
async function main() {
    await healthFactorCheckEngine.initializeHealthFactorCheckLoop();
    await healthFactorCheckEngine.performHealthFactorCheckLoop();
}

main().catch((error) => {
    common.log("Error: " + error);
    process.exit(1);
});
