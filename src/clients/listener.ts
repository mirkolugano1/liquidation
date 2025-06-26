import dotenv from "dotenv";
import engine from "../engines/engine";
import common from "../shared/common";
import webhookManager from "../managers/webhookManager";

dotenv.config();

async function main() {
    await engine.initializeAlchemyWebSocketListener();
    const aaveNetworkInfos = common.getNetworkInfos();
    for (const aaveNetworkInfo of aaveNetworkInfos) {
        for (const parameters of aaveNetworkInfo.webSocketParameters) {
            const topicSets = [
                parameters.topics[0], // Your first topic array
                null, // Match any value for topics[1]
                null, // Match any value for topics[2]
            ];
            for (const address of parameters.addresses) {
                aaveNetworkInfo.alchemy.ws.on(
                    {
                        address: address,
                        topics: topicSets,
                    },
                    async (log: any) => {
                        await webhookManager.processLog(
                            log,
                            aaveNetworkInfo.network
                        );
                    }
                );
            }
        }
    }
}

main();
