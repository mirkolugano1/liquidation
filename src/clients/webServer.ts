import dotenv from "dotenv";
import express from "express";
import logger from "../shared/logger";
import engine from "../engines/engine";

dotenv.config();
logger.initialize("webServer");
logger.setOutputTypeHTML();

const port = process.env.PORT ? parseInt(process.env.PORT) : 8080;
const app = express();
app.use(express.json());

app.get("/", (req: any, res: any) => {
    res.send("Web server is up.");
});

app.get("/logs", async (req: any, res: any) => {
    const logLevel = req.query?.logLevel;
    const env = req.query?.env;
    res.send(await logger.viewLogs(logLevel, env));
});

app.get("/healthcheck", (req, res) => {
    res.status(200).send("Healthy");
});

app.get("/loadChanges", async (req, res) => {
    await engine.loadChanges(req);
    res.status(200);
});

app.post("/aaveEvent", async (req: any, res: any) => {
    await engine.processAaveEvent(req, res);
});

app.listen(port, "0.0.0.0", async () => {
    console.log("Web server is up. Initializing engine...");
    await engine.initializeWebServer();
    console.log("Engine Initialized. Ready to receive requests...");
    engine.setCloseEvent();
});
