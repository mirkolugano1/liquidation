import healthFactorCheckEngine from "../engines/healthFactorCheckEngine";
import dotenv from "dotenv";
dotenv.config();

async function main() {
    const args = process.argv;
    if (args.length < 3)
        throw new Error("Must define function to be executed.");
    const job = args[2];

    if (healthFactorCheckEngine.hasOwnProperty(job) == false)
        throw new Error("Invalid function to be executed.");

    await (healthFactorCheckEngine as any)[job]();
}

main().catch((error) => {
    console.log("Error: " + error);
    process.exit(1);
});
