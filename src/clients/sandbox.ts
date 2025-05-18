import _ from "lodash";
import dotenv from "dotenv";
import engine from "../engines/engine";
import { Wallet } from "ethers";
import fs from "fs";
import encryptionManager from "../managers/encryptionManager";
import common from "../shared/common";

dotenv.config();

async function main() {
    try {
        await engine.doTest();
        //console.log("test");
    } catch (error) {
        console.error("Error in main function:", error);
    }
}

main();
