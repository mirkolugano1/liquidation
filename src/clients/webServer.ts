import dotenv from "dotenv";
import express from "express";
import logger from "../shared/logger";
import engine from "../engines/engine";
import webhookManager from "../managers/webhookManager";
import common from "../shared/common";
import Constants from "../shared/constants";
import repo from "../shared/repo";

// Handle unhandled promise rejections
process.on("unhandledRejection", async (reason, promise) => {
    await logger.error(
        `Unhandled Promise Rejection at: ${promise}, reason: ${reason}`
    );
    // In production, you might not want to exit
    if (!common.isProd) {
        process.exit(1);
    }
});

// Handle uncaught exceptions
process.on("uncaughtException", async (error: any) => {
    await logger.error(`Uncaught Exception: ${error.message}`, error);
    // In production, you might not want to exit immediately
    if (!common.isProd) {
        process.exit(1);
    }
});

dotenv.config();
logger.initialize("webServer");
logger.setOutputTypeHTML();

const port = process.env.PORT ? parseInt(process.env.PORT) : 8080;
const app = express();
app.use(express.json());

// Helper function to handle async route handlers
const asyncHandler = (fn: any) => (req: any, res: any, next: any) => {
    Promise.resolve(fn(req, res, next)).catch(async (error) => {
        await logger.error(`Unhandled error in route: ${error.message}`, error);
        res.status(500).send(`Internal Server Error: ${error.message}`);
    });
};

app.get("/", async (req: any, res: any) => {
    try {
        res.send("Web server is up.");
    } catch (error: any) {
        await logger.error(`Error in root endpoint: ${error.message}`, error);
        res.status(500).send(`Internal Server Error: ${error.message}`);
    }
});

app.get("/toggleRepoVar", async (req: any, res: any) => {
    try {
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
    } catch (error: any) {
        await logger.error(
            `Error in toggleRepoVar endpoint: ${error.message}`,
            error
        );
        res.status(500).send(`Internal Server Error: ${error.message}`);
    }
});

app.get("/test", (req: any, res: any) => {
    throw new Error("Test error");
});

app.get("/getVar", async (req: any, res: any) => {
    try {
        const key = req.query?.key;
        const value = engine.getVar(key);
        if (value) {
            res.send(value);
        } else {
            res.status(404).send("Key not found");
        }
    } catch (error: any) {
        await logger.error(`Error in getVar endpoint: ${error.message}`, error);
        res.status(500).send(`Internal Server Error: ${error.message}`);
    }
});

app.get(
    "/logs",
    asyncHandler(async (req: any, res: any) => {
        const logLevel = req.query?.logLevel;
        const env = req.query?.env;
        res.send(await logger.viewLogs(logLevel, env));
    })
);

app.get("/healthcheck", async (req, res) => {
    try {
        res.status(200).send("Healthy");
    } catch (error: any) {
        await logger.error(
            `Error in healthcheck endpoint: ${error.message}`,
            error
        );
        res.status(500).send(`Internal Server Error: ${error.message}`);
    }
});

app.get("/refresh", async (req, res) => {
    try {
        // Start the process but don't wait for it
        engine.refresh(req, res).catch(async (error) => {
            await logger.error(
                `Error in background refresh operation: ${error.message}`,
                error
            );
        });

        // Return immediately
        res.status(200).send("Refresh process started");
    } catch (error: any) {
        await logger.error(
            `Error starting refresh process: ${error.message}`,
            error
        );
        res.status(500).send(`Failed to start refresh: ${error.message}`);
    }
});

app.post(
    "/aaveEvent",
    asyncHandler(async (req: any, res: any) => {
        await webhookManager.processAaveEvent(req, res);
    })
);

// Global error handler middleware
app.use(async (err: any, req: any, res: any, next: any) => {
    await logger.error(`Global error handler caught: ${err.message}`, err);
    res.status(500).send({
        error: {
            message: err.message,
            stack:
                process.env.NODE_ENV === "development" ? err.stack : undefined,
        },
    });
});

// Start server
app.listen(port, "0.0.0.0", async () => {
    console.log("Web server is up. Initializing engine...");
    await engine.initializeWebServer();
    console.log("Engine Initialized. Ready to receive requests...");
    engine.setCloseEvent();
});
