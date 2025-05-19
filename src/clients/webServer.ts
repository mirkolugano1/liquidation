import dotenv from "dotenv";
import express from "express";
import logger from "../shared/logger";
import engine from "../engines/engine";
import webhookManager from "../managers/webhookManager";
import common from "../shared/common";
import Constants from "../shared/constants";
import repo from "../shared/repo";

dotenv.config();
logger.initialize("webServer");
logger.setOutputTypeHTML();

const port = process.env.PORT ? parseInt(process.env.PORT) : 8080;
const app = express();
app.use(express.json());

app.get("/", (req: any, res: any) => {
    res.send("Web server is up.");
});

app.get("toggleRepoVar", (req: any, res: any) => {
    const key = req.query?.key;
    const value = req.query?.value;
    const code = req.query?.code;
    if (code != "11") {
        res.send("Operation not allowed");
        return;
    }
    if (value) {
        (repo as any)[key] = !(repo as any)[key];
        res.send("Value set successfully");
    } else {
        res.status(404).send("Key not found");
    }
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
    engine.refresh(req, res); //not awaited, otherwise it can lead to timeout
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

    if (!common.isProd) {
        await engine.initializeReserves();
        for (const aaveNetworkInfo of common.getNetworkInfos()) {
            engine.updateUserAccountDataAndUsersReserves_loop(
                null,
                aaveNetworkInfo.network
            ); //not awaited, so that express server can start
        }
    }
});
