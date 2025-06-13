import dotenv from "dotenv";
import express from "express";
import logger from "../shared/logger";
import engine from "../engines/engine";
import webhookManager from "../managers/webhookManager";
import repo from "../shared/repo";
import moment from "moment";
import common from "../shared/common";
import encryptionManager from "../managers/encryptionManager";

dotenv.config();
logger.initialize("webServer");
logger.setOutputTypeHTML();

const port = process.env.PORT ? parseInt(process.env.PORT) : 8080;
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

app.post("/aaveEvent", async (req: any, res: any) => {
    await webhookManager.processAaveEvent(req, res);
});

app.get("/sandbox", (req: any, res: any) => {
    res.send(`
        <html>
            <body>
                <form method="post" action="/eval">
                    <label>JS Code:</label><br/>
                    <textarea name="code" rows="15" cols="100"></textarea><br/>
                    <label>Pwd:</label><br/>
                    <input type="password" name="pwd" /><br/>
                    <button type="submit">Run</button>
                </form>
            </body>
        </html>
    `);
});

app.post("/eval", async (req: any, res: any) => {
    const code = req.body?.code;
    const pwd = req.body?.pwd;

    const sandboxPasswordEncrypted = await common.getAppSetting(
        "SANDBOXPASSWORDENCRYPTED"
    );
    const sandboxPassword = await encryptionManager.decrypt(
        sandboxPasswordEncrypted
    );
    if (pwd !== sandboxPassword) {
        res.status(403).send("Forbidden: Invalid password.");
        return;
    }

    if (!code) {
        res.status(400).send("No code provided.");
        return;
    }
    try {
        // Use a Function instead of eval for better context control
        // eslint-disable-next-line no-new-func
        const fn = new Function(
            "engine",
            "logger",
            "repo",
            "webhookManager",
            "moment",
            `"use strict"; return (async () => { ${code} })()`
        );
        const result = await fn(engine, logger, repo, webhookManager, moment);
        const val = JSON.stringify(result ?? "no result", null, 2);
        res.send(`<pre>${common.escapeHtml(val)}</pre>`);
    } catch (e: any) {
        res.status(500).send(
            `<pre style="color:red">${common.escapeHtml(
                e.stack || e.message || e.toString()
            )}</pre>`
        );
    }
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
