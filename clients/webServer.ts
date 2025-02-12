import { CloudStorageManager } from "../common/cloudStorageManager";
import common from "../common/common";
import webhookEngine from "../engines/webhookEngine";
require("dotenv").config();

const express = require("express");
const app = express();

app.use(express.json());

app.get("/", (req: any, res: any) => {
    common.log("Root page opened");
    res.send("Web server is up.");
});

app.get("/healthcheck", (req: any, res: any) => {
    common.log("Healthcheck");
    res.send("Ok");
});

app.get("/testget", async (req: any, res: any) => {
    console.log("testget api hit.");
    let cloudStorageManager = new CloudStorageManager();
    await cloudStorageManager.initializeBlobClient("data", "log.txt");
    let content = await cloudStorageManager.readBlob();
    res.send(content);
});

app.post("/testpost", async (req: any, res: any) => {
    console.log("testpost api hit.");
    console.log(JSON.stringify(req.body));
    let cloudStorageManager = new CloudStorageManager();
    await cloudStorageManager.initializeBlobClient("data", "log.txt");
    let content = await cloudStorageManager.readBlob();
    content += "\n" + req.body.message;
    await cloudStorageManager.writeBlob(content);
});

app.post("/aaveEvent", async (req: any, res: any) => {
    common.log("Aave event received");
    await webhookEngine.processAaveEvent(req, res);
});

app.listen(8080, "0.0.0.0", async () => {
    common.log("Server is up and running!");
    await webhookEngine.initializeProcessAaveEvent();
    common.log("WebhookEngine is initialized");
});
