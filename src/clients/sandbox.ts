import _ from "lodash";
import dotenv from "dotenv";
import engine from "../engines/engine";
import { Wallet } from "ethers";
import fs from "fs";
import axios from "axios";
import serviceBusManager from "../managers/serviceBusManager";
import { ServiceBusMessage } from "@azure/service-bus";
import common from "../shared/common";

dotenv.config();
//logger.initialize("sandbox");
//aa
async function main() {
    try {
        /*
        const type = "updateGasPrice";
        const network = "arb-mainnet";
        const webappUrl =
            "https://liquidation-bac8gqerfpeqdpf8.westeurope-01.azurewebsites.net";
        const result = await axios.get(
            `${webappUrl}/refresh?type=${type}&network=${network}`
        );
        console.log("Result:", result);
*/

        console.log("Listening for messages...");
        await serviceBusManager.listen((receivedMessage: ServiceBusMessage) => {
            console.log("### Received message:");
            console.log(`Subject: ${receivedMessage.subject}`);
            console.log(`Body: ${JSON.stringify(receivedMessage.body)}`);
        });

        await common.sleep(10000);

        const testMessage: ServiceBusMessage = {
            subject: "TestMessage",
            body: { content: "Hello, Service Bus!" },
        };
        const testMessage1: ServiceBusMessage = {
            subject: "TestMessage 1",
            body: { content: "Hello 1, Service Bus! 1" },
        };

        await serviceBusManager.sendMessages([testMessage, testMessage1]);
        console.log("Message sent successfully!");

        //await engine.updateReservesPrices();
        //await engine.doTest();
    } catch (error) {
        console.error("Error in main function:", error);
    }
}

main();
