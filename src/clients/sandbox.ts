import _ from "lodash";
import dotenv from "dotenv";
import engine from "../engines/engine";

dotenv.config();
//logger.initialize("sandbox");

async function main() {
    try {
        if (true)
            await engine.updateHealthFactorAndUserConfigurationAndUserReserves();
        else await engine.doTest("arb");
    } catch (error) {
        console.error("Error in main function:", error);
    }
}

main();
