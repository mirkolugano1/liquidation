import dotenv from "dotenv";
import express from "express";
import logger from "../shared/logger";
import engine from "../engines/engine";
import webhookManager from "../managers/webhookManager";

dotenv.config();
logger.initialize("webServer");
logger.setOutputTypeHTML();

const port = process.env.PORT ? parseInt(process.env.PORT) : 8080;
const app = express();
app.use(express.json());

app.get("/", (req: any, res: any) => {
    res.send("Web server is up.");
});

app.get("getVar", (req: any, res: any) => {
    const key = req.query?.key;
    const value = engine.getVar(key);
    if (value) {
        res.send(value);
    } else {
        res.status(404).send("Key not found");
    }
});

app.get("/logs", async (req: any, res: any) => {
    const logLevel = req.query?.logLevel;
    const env = req.query?.env;
    res.send(await logger.viewLogs(logLevel, env));
});

app.get("/healthcheck", (req, res) => {
    res.status(200).send("Healthy");
});

app.get("/refresh", async (req, res) => {
    await engine.refresh(req, res);
    res.status(200);
});

app.post("/aaveEvent", async (req: any, res: any) => {
    await webhookManager.processAaveEvent(req, res);
});

app.listen(port, "0.0.0.0", async () => {
    console.log("Web server is up. Initializing engine...");
    await engine.initializeWebServer();
    console.log("Engine Initialized. Ready to receive requests...");
    engine.setCloseEvent();
});
