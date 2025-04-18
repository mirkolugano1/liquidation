import common from "../shared/common";
import encryption from "./encryptionManager";
import {
    ServiceBusClient,
    ServiceBusMessage,
    ServiceBusReceiver,
    ServiceBusSender,
} from "@azure/service-bus";

import dotenv from "dotenv";
import logger from "../shared/logger";
import Constants from "../shared/constants";
import _ from "lodash";
dotenv.config();

class ServiceBusManager {
    private static instance: ServiceBusManager;
    private serviceBusClient: ServiceBusClient | null = null;
    private serviceBusReceiver: ServiceBusReceiver | null = null;
    private serviceBusSender: ServiceBusSender | null = null;
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

    async initializeSender() {
        if (this.serviceBusSender) return;
        await this.initialize();
        this.serviceBusSender = this.serviceBusClient!.createSender(
            this.queueName
        );
    }

    async close() {
        if (this.serviceBusSender) {
            await this.serviceBusSender.close();
            this.serviceBusSender = null;
        }
        if (this.serviceBusReceiver) {
            await this.serviceBusReceiver.close();
            this.serviceBusReceiver = null;
        }
        if (this.serviceBusClient) {
            await this.serviceBusClient.close();
            this.serviceBusClient = null;
        }
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
        this.serviceBusReceiver!.subscribe({
            processMessage: async (message: ServiceBusMessage) => {
                console.log("Received message:");
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
        body: string | null = null
    ) {
        await this.initializeSender();
        const message = {
            body: body,
            applicationProperties: properties,
            subject: subject,
        };
        await this.serviceBusSender!.sendMessages(message);
    }
}

export default ServiceBusManager.getInstance();
