import webhookEngine from "../engines/webhookEngine";
import dotenv from "dotenv";
import express from "express";

dotenv.config();
const app = express();
app.use(express.json());

app.get("/", (req: any, res: any) => {
    res.send("Web server is up.");
});

app.get("/healthcheck", (req: any, res: any) => {
    res.send("Ok");
});

app.get("/var", async (req: any, res: any) => {
    res.send(webhookEngine.manageVariable(req));
});

app.post("/aaveEvent", async (req: any, res: any) => {
    await webhookEngine.processAaveEvent(req, res);
});

app.listen(8080, "0.0.0.0", async () => {
    console.log("Web server is up. Initializing webhookEngine...");
    await webhookEngine.initializeWebhookEngine();
    console.log("Initialization complete.");
});
