import webhookEngine from "../engines/webhookEngine";
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
    await webhookEngine.initializeProcessAaveEvent();
    console.log("Server is running on http://localhost:80");
});
