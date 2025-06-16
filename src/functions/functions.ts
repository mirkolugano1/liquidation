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

// =========== Gas Price Update ===========
// Orchestrator for gas price update
const updateGasPriceOrchestrator: OrchestrationHandler = function* (
    context: OrchestrationContext
) {
    yield context.df.callActivity("updateGasPriceActivity");
};

// Activity function for gas price update
const updateGasPriceActivity: ActivityHandler = async (
    input: unknown,
    context: InvocationContext
) => {
    await engine.updateGasPrice(context);
};

// Timer trigger for gas price update
const updateGasPriceTimer = async (
    myTimer: Timer,
    context: InvocationContext
): Promise<void> => {
    const client = df.getClient(context);
    const instanceId = await client.startNew("updateGasPriceOrchestrator");
};

// Register orchestrator and activity
df.app.orchestration("updateGasPriceOrchestrator", updateGasPriceOrchestrator);
df.app.activity("updateGasPriceActivity", { handler: updateGasPriceActivity });

// Register timer function
app.timer("updateGasPriceTimer", {
    schedule: "0 0 * * *", // Cron expression for every day at 00:00 h
    extraInputs: [df.input.durableClient()],
    handler: updateGasPriceTimer,
});

// =========== Update Reserves Data ===========
// Orchestrator for updating reserves data
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

// Activity function for updating reserves data
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

// Timer trigger for updating reserves data
const updateReservesDataTimer = async (
    myTimer: Timer,
    context: InvocationContext
): Promise<void> => {
    const client = df.getClient(context);
    const instanceId = await client.startNew("updateReservesDataOrchestrator");
};

// Register orchestrator and activity
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

// Register timer function
app.timer("updateReservesDataTimer", {
    schedule: "5 0 * * *", // Cron expression for every day at 00:05 h
    extraInputs: [df.input.durableClient()],
    handler: updateReservesDataTimer,
});

// =========== Update Reserves Prices ===========
// Orchestrator for updating reserves prices
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

// Activity function for updating reserves prices
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

// Timer trigger for updating reserves prices
const updateReservesPricesTimer = async (
    myTimer: Timer,
    context: InvocationContext
): Promise<void> => {
    const client = df.getClient(context);
    const instanceId = await client.startNew(
        "updateReservesPricesOrchestrator"
    );
};

// Register orchestrator and activity
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

// Register timer function
app.timer("updateReservesPricesTimer", {
    schedule: "*/15 * * * *", // Cron expression for every day at 00:15 h
    extraInputs: [df.input.durableClient()],
    handler: updateReservesPricesTimer,
});

// =========== Update User Account Data And User Reserves ===========
// Orchestrator
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

// Activity function
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

// Timer trigger
const updateUserAccountDataAndUsersReservesTimer = async (
    myTimer: Timer,
    context: InvocationContext
): Promise<void> => {
    const client = df.getClient(context);
    const instanceId = await client.startNew(
        "updateUserAccountDataAndUsersReservesOrchestrator"
    );
};

// Register orchestrator and activity
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

// Register timer function
app.timer("updateUserAccountDataAndUsersReservesTimer", {
    schedule: "*/15 * * * *", // Cron expression for every n minutes
    extraInputs: [df.input.durableClient()],
    handler: updateUserAccountDataAndUsersReservesTimer,
});
