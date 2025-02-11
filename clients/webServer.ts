import common from "../common/common";
import webhookEngine from "../engines/webhookEngine";
require("dotenv").config();

const express = require("express");
const app = express();

app.use(express.json());

app.get("/", (req: any, res: any) => {
    res.send("Web server is up.");
});

app.post("/aaveEvent", async (req: any, res: any) => {
    await webhookEngine.processAaveEvent(req, res);
});

app.listen(80, async () => {
    //common.log("Server is up and running!");
    //await webhookEngine.initializeProcessAaveEvent();
    //common.log("WebhookEngine is initialized");
});
