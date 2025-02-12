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

app.post("/testpost", async (req: any, res: any) => {
    console.log("testpost api hit.");
    console.log(JSON.stringify(req.body));
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
