import { app, Timer, InvocationContext } from "@azure/functions";
import * as df from "durable-functions";
import {
    ActivityHandler,
    OrchestrationContext,
    OrchestrationHandler,
} from "durable-functions";
import engine from "../engines/engine";
import { Network } from "alchemy-sdk";
import common from "../shared/common";

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
    yield context.df.callActivity("updateReservesDataActivity_initialization");
    for (const aaveNetworkInfo of common.getNetworkInfos()) {
        yield context.df.callActivity("updateReservesDataActivity_loop", {
            network: aaveNetworkInfo.network,
        });
    }
};

const updateReservesDataActivity_initialization: ActivityHandler = async (
    input: unknown,
    context: InvocationContext
) => {
    await engine.updateReservesData_initialization(context);
};

const updateReservesDataActivity_loop: ActivityHandler = async (
    input: { network: Network },
    context: InvocationContext
) => {
    await engine.updateReservesData_loop(context, input.network);
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
df.app.activity("updateReservesDataActivity_initialization", {
    handler: updateReservesDataActivity_initialization,
});
df.app.activity("updateReservesDataActivity_loop", {
    handler: updateReservesDataActivity_loop,
});

//#endregion Update Reserves Data

//#region Update Reserves Prices

const updateReservesPricesOrchestrator: OrchestrationHandler = function* (
    context: OrchestrationContext
) {
    yield context.df.callActivity(
        "updateReservesPricesActivity_initialization"
    );
    for (const aaveNetworkInfo of common.getNetworkInfos()) {
        yield context.df.callActivity("updateReservesPricesActivity_loop", {
            network: aaveNetworkInfo.network,
        });
    }
};

const updateReservesPricesActivity_initialization: ActivityHandler = async (
    input: unknown,
    context: InvocationContext
) => {
    await engine.updateReservesPrices_initialization(context);
};
const updateReservesPricesActivity_loop: ActivityHandler = async (
    input: { network: Network },
    context: InvocationContext
) => {
    await engine.updateReservesPrices_loop(context, input.network);
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
df.app.activity("updateReservesPricesActivity_initialization", {
    handler: updateReservesPricesActivity_initialization,
});
df.app.activity("updateReservesPricesActivity_loop", {
    handler: updateReservesPricesActivity_loop,
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

app.timer("updateGasPriceTimer", {
    schedule: "0 0 * * *", // Cron expression for every day at 00:00 h
    extraInputs: [df.input.durableClient()],
    handler: updateGasPriceTimer,
});
/*
app.timer("updateReservesDataTimer", {
    schedule: "5 0 * * *", // Cron expression for every day at 00:05 h
    extraInputs: [df.input.durableClient()],
    handler: updateReservesDataTimer,
});

app.timer("updateReservesPricesTimer", {
    schedule: "15 * * * *", // Cron expression for every 15 minutes
    extraInputs: [df.input.durableClient()],
    handler: updateReservesPricesTimer,
});

app.timer("updateUserAccountDataAndUsersReservesTimer", {
    schedule: "16 * * * *", // Cron expression for every n minutes
    extraInputs: [df.input.durableClient()],
    handler: updateUserAccountDataAndUsersReservesTimer,
});
*/
app.timer("startupFunction", {
    schedule: "10 * * * *", // Daily at midnight (or whatever schedule you want)
    extraInputs: [df.input.durableClient()],
    runOnStartup: true, // This makes it run immediately on startup
    handler: async (
        myTimer: Timer,
        context: InvocationContext
    ): Promise<void> => {
        context.log("Delayed startup function executed.");
        await common.sleep(10000);
        //actual call
        await updateGasPriceTimer(myTimer, context);
    },
});

//#endregion Timers
