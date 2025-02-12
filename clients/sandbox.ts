import { CloudStorageManager } from "../common/cloudStorageManager";
import common from "../common/common";
import encryption from "../common/encryption";
import keccak from "../common/keccak";
require("dotenv").config();

async function main() {
    //await fileUtilities.writeToTextFile("./data/aaveEvent.json", "test");
    //console.log("test");
    //await webhookEngine.test();
    //common.isProd = true;
    //common.log("Mirkos test log");
    //let a = await encryption.encrypt(key, process.env.ENCRYPTIONPWD!);
    //console.log(a);
    let cloudStorageManager = new CloudStorageManager();
    await cloudStorageManager.initializeBlobClient("data", "addresses.txt");
    let c = await cloudStorageManager.readBlob();

    c += "\nsome text to append";
    await cloudStorageManager.writeBlob(c);
    let cc = await cloudStorageManager.readBlob();

    console.log(cc);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("Error:", error);
        process.exit(1);
    });
