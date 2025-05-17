import { app, Timer, InvocationContext } from "@azure/functions";
import * as df from "durable-functions";
import {
    ActivityHandler,
    OrchestrationContext,
    OrchestrationHandler,
} from "durable-functions";
import engine from "../engines/engine";
import { Network } from "alchemy-sdk";
import Constants from "../shared/constants";
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

// =========== Delete Old Tables Entries ===========
// Orchestrator for deleting old table entries
const deleteOldTablesEntriesOrchestrator: OrchestrationHandler = function* (
    context: OrchestrationContext
) {
    // Call the activity function to delete old table entries
    yield context.df.callActivity("deleteOldTablesEntriesActivity");
};

// Activity function for deleting old table entries
const deleteOldTablesEntriesActivity: ActivityHandler = async (
    input: unknown,
    context: InvocationContext
) => {
    await engine.deleteOldTablesEntries(context);
};

// Timer trigger for deleting old table entries
const deleteOldTablesEntriesTimer = async (
    myTimer: Timer,
    context: InvocationContext
): Promise<void> => {
    const client = df.getClient(context);
    const instanceId = await client.startNew(
        "deleteOldTablesEntriesOrchestrator"
    );
};

// Register orchestrator and activity
df.app.orchestration(
    "deleteOldTablesEntriesOrchestrator",
    deleteOldTablesEntriesOrchestrator
);
df.app.activity("deleteOldTablesEntriesActivity", {
    handler: deleteOldTablesEntriesActivity,
});

// Register timer function
app.timer("deleteOldTablesEntriesTimer", {
    schedule: "1 0 * * *", // Cron expression for every day at 00:01 h
    extraInputs: [df.input.durableClient()],
    handler: deleteOldTablesEntriesTimer,
});

// =========== Update Reserves Data ===========
// Orchestrator for updating reserves data
const updateReservesDataOrchestrator: OrchestrationHandler = function* (
    context: OrchestrationContext
) {
    const logger = yield context.df.callActivity(
        "updateReservesDataActivity_initialization"
    );
    for (const aaveNetworkInfo of common.getNetworkInfos()) {
        yield context.df.callActivity("updateReservesDataActivity_loop", {
            network: aaveNetworkInfo.network,
        });
    }
    logger.log("End updateReservesData");
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
    yield context.df.callActivity("updateReservesPricesActivity");
};

// Activity function for updating reserves prices
const updateReservesPricesActivity: ActivityHandler = async (
    input: unknown,
    context: InvocationContext
) => {
    await engine.updateReservesPrices(context);
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
df.app.activity("updateReservesPricesActivity", {
    handler: updateReservesPricesActivity,
});

// Register timer function
app.timer("updateReservesPricesTimer", {
    schedule: "15 0 * * *", // Cron expression for every day at 00:15 h
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
            let offset = 0;
            let hasMoreResults = true;
            do {
                hasMoreResults = yield context.df.callActivity(
                    "updateUserAccountDataAndUsersReservesActivity_loop",
                    { network: aaveNetworkInfo.network, offset: offset }
                );
                offset += Constants.CHUNK_SIZE;
            } while (hasMoreResults);
        }
    };

// Activity function
const updateUserAccountDataAndUsersReservesActivity_initialization: ActivityHandler =
    async (input: unknown, context: InvocationContext) => {
        await engine.updateUserAccountDataAndUsersReserves_initialization(
            context
        );
    };

const updateUserAccountDataAndUsersReservesActivity_loop: ActivityHandler =
    async (
        input: { network: Network; offset: number },
        context: InvocationContext
    ) => {
        await engine.updateUserAccountDataAndUsersReserves_loop(
            context,
            input.network,
            input.offset
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
df.app.activity("updateUserAccountDataAndUsersReservesActivity_loop", {
    handler: updateUserAccountDataAndUsersReservesActivity_loop,
});

// Register timer function
app.timer("updateUserAccountDataAndUsersReservesTimer", {
    schedule: "30 0 * * *", // Cron expression for every day at 00:15 h
    extraInputs: [df.input.durableClient()],
    handler: updateUserAccountDataAndUsersReservesTimer,
});
