import fileUtilities from "../common/fileUtilities";
import webhookEngine from "../engines/webhookEngine";

async function main() {
    //await fileUtilities.writeToTextFile("./data/aaveEvent.json", "test");
    //console.log("test");
    await webhookEngine.test();
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("Error:", error);
        process.exit(1);
    });
