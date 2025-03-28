import webhookEngine from "../engines/webhookEngine";
import dotenv from "dotenv";
import express from "express";
import logger from "../shared/logger";
import healthFactorCheckEngine from "../engines/healthFactorCheckEngine";

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
    res.send(await logger.viewLogs(logLevel));
});

app.get("/health", (req, res) => {
    res.status(200).send("Healthy");
});

app.get("/var", async (req: any, res: any) => {
    res.send(webhookEngine.manageVariable(req));
});

app.post("/aaveEvent", async (req: any, res: any) => {
    await webhookEngine.processAaveEvent(req, res);
});

app.listen(port, "0.0.0.0", async () => {
    console.log("Web server is up. Initializing engines...");
    await webhookEngine.initialize();
    await healthFactorCheckEngine.initialize();
    console.log("Engines Initialized.");
});
