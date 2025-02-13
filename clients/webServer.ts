import { CloudStorageManager } from "../common/cloudStorageManager";
import common from "../common/common";
import webhookEngine from "../engines/webhookEngine";
require("dotenv").config();

const express = require("express");
const app = express();

app.use(express.json());

app.get("/", (req: any, res: any) => {
    res.send("Web server is up.");
});

app.get("/healthcheck", (req: any, res: any) => {
    res.send("Ok");
});

app.post("/aaveEvent", async (req: any, res: any) => {
    await webhookEngine.processAaveEvent(req, res);
});

app.listen(8080, "0.0.0.0", async () => {
    await webhookEngine.initializeProcessAaveEvent();
});
