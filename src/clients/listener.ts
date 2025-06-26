import dotenv from "dotenv";
import engine from "../engines/engine";
import common from "../shared/common";
import webSocketManager from "../managers/webSocketManager";

dotenv.config();

async function main() {
    await engine.initializeAlchemy();
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
                        await webSocketManager.processLog(
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
