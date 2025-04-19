import { DefaultAzureCredential } from "@azure/identity";
import common from "../shared/common";
import logger from "../shared/logger";
import encryptionManager from "./encryptionManager";
import {
    ServiceBusClient,
    ServiceBusMessage,
    ServiceBusReceivedMessage,
    ServiceBusReceiver,
    ServiceBusSender,
} from "@azure/service-bus";

class ServiceBusManager {
    private static instance: ServiceBusManager;
    private serviceBusClient: ServiceBusClient | null = null;
    public serviceBusReceiver: ServiceBusReceiver | null = null;
    private serviceBusSender: ServiceBusSender | null = null;
    private queueName: string = "liquidationqueue";
    private isListening: boolean = false;

    public static getInstance(): ServiceBusManager {
        if (!ServiceBusManager.instance) {
            ServiceBusManager.instance = new ServiceBusManager();
        }
        return ServiceBusManager.instance;
    }

    private async initialize() {
        if (this.serviceBusClient) return;

        try {
            console.log("Initializing ServiceBusClient...");
            const connectionStringEncrypted = await common.getAppSetting(
                "SERVICEBUSCONNECTIONSTRINGENCRYPTED"
            );
            const connectionString = await encryptionManager.decrypt(
                connectionStringEncrypted
            );
            if (!connectionString) {
                throw new Error(
                    "Azure Service Bus connection string is not set."
                );
            }
            this.serviceBusClient = new ServiceBusClient(connectionString);
            console.log("ServiceBusClient initialized successfully");
        } catch (error) {
            console.error("Failed to initialize ServiceBusClient:", error);
            throw error;
        }
    }

    async initializeSender() {
        if (this.serviceBusSender) return;

        try {
            console.log("Initializing ServiceBusSender...");
            await this.initialize();
            this.serviceBusSender = this.serviceBusClient!.createSender(
                this.queueName
            );
            console.log("ServiceBusSender initialized successfully");
        } catch (error) {
            console.error("Failed to initialize ServiceBusSender:", error);
            throw error;
        }
    }

    async close() {
        console.log("Closing ServiceBus connections...");

        if (this.serviceBusSender) {
            await this.serviceBusSender.close();
            this.serviceBusSender = null;
            console.log("ServiceBusSender closed");
        }

        if (this.serviceBusReceiver) {
            await this.serviceBusReceiver.close();
            this.serviceBusReceiver = null;
            console.log("ServiceBusReceiver closed");
        }

        if (this.serviceBusClient) {
            await this.serviceBusClient.close();
            this.serviceBusClient = null;
            console.log("ServiceBusClient closed");
        }

        console.log("All ServiceBus connections closed");
    }

    async initializeReceiver() {
        if (this.serviceBusReceiver) return;

        try {
            console.log("Initializing ServiceBusReceiver...");
            await this.initialize();

            this.serviceBusReceiver = this.serviceBusClient!.createReceiver(
                this.queueName,
                {
                    receiveMode: "receiveAndDelete", // Change to peekLock for better control
                }
            );

            console.log(
                "ServiceBusReceiver initialized, waiting 5 seconds for stabilization..."
            );
            await common.sleep(5000);
            console.log("ServiceBusReceiver ready");
        } catch (error) {
            console.error("Failed to initialize ServiceBusReceiver:", error);
            throw error;
        }
    }

    async listen(processMessageCallback: any = null) {
        if (this.isListening) {
            console.log("Already listening to messages, skipping...");
            return;
        }

        try {
            await this.initializeReceiver();
            this.serviceBusReceiver!.subscribe({
                processMessage: async (message: ServiceBusMessage) => {
                    console.log("Received message:", message.subject);
                    if (processMessageCallback) {
                        processMessageCallback(message);
                    }
                },
                processError: async (error: any) => {
                    throw error;
                },
            });

            this.isListening = true;
        } catch (error) {
            console.error("Failed to set up message listener:", error);
            throw error;
        }
    }

    async sendMessages(messages: ServiceBusMessage | ServiceBusMessage[]) {
        try {
            await this.initializeSender();
            await this.serviceBusSender!.sendMessages(messages);
        } catch (error) {
            console.error("Failed to send message:", error);
            throw error;
        }
    }
}
export default ServiceBusManager.getInstance();
