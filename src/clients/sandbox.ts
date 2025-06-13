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
        //await encryptionManager.createPemFileFromPrivateKey();
        await engine.doTest();
        //console.log("test");
        process.exit(0);
    } catch (error) {
        console.error("Error in main function:", error);
        process.exit(1);
    }
}

main();
