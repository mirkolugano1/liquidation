import {
    app,
    Timer,
    InvocationContext,
    HttpRequest,
    HttpResponseInit,
} from "@azure/functions";
import * as df from "durable-functions";
import {
    ActivityHandler,
    OrchestrationContext,
    OrchestrationHandler,
} from "durable-functions";
import engine from "../engines/engine";
import { Network } from "alchemy-sdk";
import common from "../shared/common";
import webhookManager from "../managers/webhookManager";
import redisManager from "../managers/redisManager";

//#region Gas Price Update

const redisPingOrchestrator: OrchestrationHandler = function* (
    context: OrchestrationContext
) {
    yield context.df.callActivity("redisPingActivity");
};

const redisPingActivity: ActivityHandler = async (
    input: unknown,
    context: InvocationContext
) => {
    await engine.redisPing(context);
};

const redisPingTimer = async (
    myTimer: Timer,
    context: InvocationContext
): Promise<void> => {
    const client = df.getClient(context);
    const instanceId = await client.startNew("redisPingOrchestrator");
};

df.app.orchestration("redisPingOrchestrator", redisPingOrchestrator);
df.app.activity("redisPingActivity", { handler: redisPingActivity });

//#endregion Gas Price Update

//#region Gas Price Update

const updateGasPriceOrchestrator: OrchestrationHandler = function* (
    context: OrchestrationContext
) {
    yield context.df.callActivity("updateGasPriceActivity");
};

const updateGasPriceActivity: ActivityHandler = async (
    input: unknown,
    context: InvocationContext
) => {
    await engine.updateGasPrice(context);
};

const updateGasPriceTimer = async (
    myTimer: Timer,
    context: InvocationContext
): Promise<void> => {
    const client = df.getClient(context);
    const instanceId = await client.startNew("updateGasPriceOrchestrator");
};

df.app.orchestration("updateGasPriceOrchestrator", updateGasPriceOrchestrator);
df.app.activity("updateGasPriceActivity", { handler: updateGasPriceActivity });

//#endregion Gas Price Update

//#region Update Reserves Data

const updateReservesDataOrchestrator: OrchestrationHandler = function* (
    context: OrchestrationContext
) {
    for (const aaveNetworkInfo of common.getNetworkInfos()) {
        yield context.df.callActivity("updateReservesDataActivity", {
            network: aaveNetworkInfo.network,
        });
    }
};

const updateReservesDataActivity: ActivityHandler = async (
    input: { network: Network },
    context: InvocationContext
) => {
    await engine.updateReservesData(context, input.network);
};

const updateReservesDataTimer = async (
    myTimer: Timer,
    context: InvocationContext
): Promise<void> => {
    const client = df.getClient(context);
    const instanceId = await client.startNew("updateReservesDataOrchestrator");
};

df.app.orchestration(
    "updateReservesDataOrchestrator",
    updateReservesDataOrchestrator
);
df.app.activity("updateReservesDataActivity", {
    handler: updateReservesDataActivity,
});

//#endregion Update Reserves Data

//#region Update Reserves Prices

const updateReservesPricesOrchestrator: OrchestrationHandler = function* (
    context: OrchestrationContext
) {
    for (const aaveNetworkInfo of common.getNetworkInfos()) {
        yield context.df.callActivity("updateReservesPricesActivity", {
            network: aaveNetworkInfo.network,
        });
    }
};

const updateReservesPricesActivity: ActivityHandler = async (
    input: { network: Network },
    context: InvocationContext
) => {
    await engine.updateReservesPrices(context, input.network);
};

const updateReservesPricesTimer = async (
    myTimer: Timer,
    context: InvocationContext
): Promise<void> => {
    const client = df.getClient(context);
    const instanceId = await client.startNew(
        "updateReservesPricesOrchestrator"
    );
};

df.app.orchestration(
    "updateReservesPricesOrchestrator",
    updateReservesPricesOrchestrator
);
df.app.activity("updateReservesPricesActivity", {
    handler: updateReservesPricesActivity,
});

//#endregion Update Reserves Prices

//#region Update User Account Data And User Reserves

const updateUserAccountDataAndUsersReservesOrchestrator: OrchestrationHandler =
    function* (context: OrchestrationContext) {
        yield context.df.callActivity(
            "updateUserAccountDataAndUsersReservesActivity_initialization"
        );
        for (const aaveNetworkInfo of common.getNetworkInfos()) {
            let hasMoreData = true;
            while (hasMoreData) {
                hasMoreData = yield context.df.callActivity(
                    "updateUserAccountDataAndUsersReservesActivity_chunk",
                    { network: aaveNetworkInfo.network }
                );
            }
        }
    };

const updateUserAccountDataAndUsersReservesActivity_initialization: ActivityHandler =
    async (input: any, context: InvocationContext) => {
        await engine.updateUserAccountDataAndUsersReserves_initialization(
            context
        );
    };
const updateUserAccountDataAndUsersReservesActivity_chunk: ActivityHandler =
    async (input: { network: Network }, context: InvocationContext) => {
        await engine.updateUserAccountDataAndUsersReserves_chunk(
            context,
            input.network
        );
    };

const updateUserAccountDataAndUsersReservesTimer = async (
    myTimer: Timer,
    context: InvocationContext
): Promise<void> => {
    const client = df.getClient(context);
    const instanceId = await client.startNew(
        "updateUserAccountDataAndUsersReservesOrchestrator"
    );
};

df.app.orchestration(
    "updateUserAccountDataAndUsersReservesOrchestrator",
    updateUserAccountDataAndUsersReservesOrchestrator
);
df.app.activity(
    "updateUserAccountDataAndUsersReservesActivity_initialization",
    {
        handler: updateUserAccountDataAndUsersReservesActivity_initialization,
    }
);
df.app.activity("updateUserAccountDataAndUsersReservesActivity_chunk", {
    handler: updateUserAccountDataAndUsersReservesActivity_chunk,
});

//#endregion Update User Account Data And User Reserves

//#region Timers

//functions to be executed once per day

app.timer("updateGasPriceTimer", {
    schedule: "0 0 * * *", // Cron expression for every day at 00:00 h
    extraInputs: [df.input.durableClient()],
    useMonitor: false, //disables catch-up behavior of functions on startup
    handler: updateGasPriceTimer,
});

app.timer("updateReservesDataTimer", {
    schedule: "5 0 * * *", // Cron expression for every day at 00:05 h
    extraInputs: [df.input.durableClient()],
    useMonitor: false,
    handler: updateReservesDataTimer,
});

//end functions to be executed once per day

//functions to be executed every n minutes

//todo for prod modify these timers to run every n minutes
app.timer("updateReservesPricesTimer", {
    schedule: common.getCronScheduleByJobName("updateReservesPricesTimer"),
    extraInputs: [df.input.durableClient()],
    useMonitor: false,
    handler: updateReservesPricesTimer,
});

app.timer("updateUserAccountDataAndUsersReservesTimer", {
    schedule: common.getCronScheduleByJobName(
        "updateUserAccountDataAndUsersReservesTimer"
    ),
    extraInputs: [df.input.durableClient()],
    useMonitor: false,
    handler: updateUserAccountDataAndUsersReservesTimer,
});

app.timer("redisPing", {
    schedule: "*/2 * * * *", // Cron expression for every n minutes
    extraInputs: [df.input.durableClient()],
    useMonitor: false,
    handler: redisPingTimer,
});

//end functions to be executed every n minutes

//todo local.settings.json redis connection string: set to production redis connection string

//startup function (only to run locally)
app.timer("startupFunction", {
    schedule: "0 0 * * *", // Daily at midnight (or whatever schedule you want)
    extraInputs: [df.input.durableClient()],
    runOnStartup: true, // This makes it run immediately on startup
    handler: async (
        myTimer: Timer,
        context: InvocationContext
    ): Promise<void> => {
        try {
            //Todo setup all necessary initialization and checks, so that in production the app is ready to run
            //and not crash on startup (e.g. redis connection, etc.)
            await engine.initializeFunction(context);
        } catch (error) {
            context.log("❌ CRITICAL: Initialization failed:", error);

            if (common.isProd) {
                // In production, exit the process to prevent unhealthy instance
                context.log("🛑 Exiting process due to initialization failure");
                process.exit(1);
            } else {
                // In dev, just throw to see the error
                throw error;
            }
        }
    },
});

//#endregion Timers

const alchemyWebhook = async (
    request: HttpRequest,
    context: InvocationContext
): Promise<HttpResponseInit> => {
    const webhookData = (await request.json()) as any;
    const client = df.getClient(context);

    context.log(`Alchemy webhook received: ${JSON.stringify(webhookData)}`);
    //await webhookManager.processAaveEvent(request, context);

    return {
        status: 200,
        jsonBody: {
            success: true,
            message: "Webhook endpoint processed successfully",
        },
    };
};

// Register the webhook endpoint
app.http("alchemyWebhook", {
    methods: ["POST"],
    authLevel: "anonymous",
    route: "webhook/alchemy",
    extraInputs: [df.input.durableClient()],
    handler: alchemyWebhook,
});
