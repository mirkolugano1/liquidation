import common from "../common/common";
require("dotenv").config();

async function main() {
    //await fileUtilities.writeToTextFile("./data/aaveEvent.json", "test");
    //console.log("test");
    //await webhookEngine.test();
    common.isProd = true;
    //common.log("Mirkos test log");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("Error:", error);
        process.exit(1);
    });
