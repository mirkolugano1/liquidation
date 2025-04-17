import common from "../shared/common";
import encryption from "./encryptionManager";
import { ServiceBusClient, ServiceBusMessage } from "@azure/service-bus";

import dotenv from "dotenv";
import logger from "../shared/logger";
import Constants from "../shared/constants";
import _ from "lodash";
dotenv.config();

class ServiceBusManager {
    private static instance: ServiceBusManager;
    private serviceBusClient: ServiceBusClient | null = null;
    private serviceBusReceiver: any = null;
    private queueName: string = "liquidationqueue";

    public static getInstance(): ServiceBusManager {
        if (!ServiceBusManager.instance) {
            ServiceBusManager.instance = new ServiceBusManager();
        }
        return ServiceBusManager.instance;
    }

    private async initialize() {
        if (this.serviceBusClient) return;

        const connectionStringEncrypted = await common.getAppSetting(
            "SERVICEBUSCONNECTIONSTRINGENCRYPTED"
        );
        const connectionString = await encryption.decrypt(
            connectionStringEncrypted
        );
        if (!connectionString) {
            throw new Error("Azure Service Bus connection string is not set.");
        }
        this.serviceBusClient = new ServiceBusClient(connectionString);
    }

    async initializeReceiver() {
        if (this.serviceBusReceiver) return;
        await this.initialize();
        this.serviceBusReceiver = this.serviceBusClient!.createReceiver(
            this.queueName,
            {
                receiveMode: "receiveAndDelete",
            }
        );
    }

    async listenToMessages(processMessageCallback: any = null) {
        await this.initializeReceiver();
        this.serviceBusReceiver.subscribe({
            processMessage: async (message: ServiceBusMessage) => {
                if (processMessageCallback)
                    await processMessageCallback(message);
            },
            processError: async (err: any) => {
                await logger.log(err, "error");
            },
        });
    }

    async sendMessageToQueue(
        subject: string,
        properties: any,
        chunkPropertyName: string | null = null,
        body: string | null = null
    ) {
        await this.initialize();
        const sender = this.serviceBusClient!.createSender(this.queueName);
        if (chunkPropertyName) {
            const cleanedProperties = _.omit(properties, chunkPropertyName);
            const chunks = _.chunk(
                properties[chunkPropertyName],
                Constants.CHUNK_SIZE / 2
            );
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                const message = {
                    body: body,
                    applicationProperties: {
                        ...cleanedProperties,
                        [chunkPropertyName]: chunk.join(","),
                        chunks: chunks.length,
                        chunkIndex: i,
                    },
                    subject: subject,
                };
                await sender.sendMessages(message);
            }
        } else {
            const message = {
                body: body,
                applicationProperties: properties,
                subject: subject,
            };
            await sender.sendMessages(message);
        }
    }
}

export default ServiceBusManager.getInstance();
