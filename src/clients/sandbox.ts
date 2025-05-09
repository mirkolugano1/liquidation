import _ from "lodash";
import dotenv from "dotenv";
import engine from "../engines/engine";

dotenv.config();
//logger.initialize("sandbox");
//aa
async function main() {
    try {
        await engine.updateReservesPrices();
        //await engine.doTest();
    } catch (error) {
        console.error("Error in main function:", error);
    }
}

main();
