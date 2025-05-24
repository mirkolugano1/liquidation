import dotenv from "dotenv";
import express from "express";
import logger from "../shared/logger";
import engine from "../engines/engine";
import webhookManager from "../managers/webhookManager";
import repo from "../shared/repo";
import moment from "moment";

dotenv.config();
logger.initialize("webServer");
logger.setOutputTypeHTML();

const port = process.env.PORT ? parseInt(process.env.PORT) : 8080;
const app = express();
app.use(express.json());

app.get("/", async (req: any, res: any) => {
    res.send("Web server is up.");
});

app.get("/test", (req: any, res: any) => {
    throw new Error("Test error");
});

app.get("/getVar", async (req: any, res: any) => {
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

app.get("/healthcheck", async (req, res) => {
    res.status(200).send("Healthy");
});

app.get("/refresh", async (req, res) => {
    // Start the process but don't wait for it
    engine.refresh(req, res).catch(async (error) => {
        await logger.error(
            `Error in background refresh operation: ${error.message}`,
            error
        );
    });

    // Return immediately
    res.status(200).send("Refresh process started");
});

app.post("/aaveEvent", async (req: any, res: any) => {
    await webhookManager.processAaveEvent(req, res);
});

// Start server
app.listen(port, "0.0.0.0", async () => {
    //not awaiting this to allow the server to start immediately
    engine.initializeWebServer();

    engine.setCloseEvent();
    await logger.log(
        `Web server started: ${moment.utc().format("YYYY-MM-DD HH:mm:ss")}`
    );
});
