import common from "../common/common";
import webhookEngine from "../engines/webhookEngine";
require("dotenv").config();

const express = require("express");
const app = express();

app.use(express.json());

app.get("/", (req: any, res: any) => {
    console.log("Root page opened");
    res.send("Web server is up.");
});

app.get("/healthcheck", (req: any, res: any) => {
    console.log("Healthcheck");
    res.send("Ok");
});

app.post("/aaveEvent", async (req: any, res: any) => {
    await webhookEngine.processAaveEvent(req, res);
});

app.listen(80, "0.0.0.0", async () => {
    console.log("WebServer is Up");
    common.log("Server is up and running!");
    await webhookEngine.initializeProcessAaveEvent();
    common.log("WebhookEngine is initialized");
});
