import _ from "lodash";
import dotenv from "dotenv";
dotenv.config();

process.on("unhandledRejection", (reason, promise) => {
    process.exit(1);
});

async function main() {
    //await healthFactorCheckEngine.doTest();
    throw new Error("Not implemented");
}

await main();
process.exit(0);
