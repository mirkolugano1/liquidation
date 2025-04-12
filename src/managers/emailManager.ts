import {
    EmailClient,
    EmailMessage,
    EmailRecipients,
} from "@azure/communication-email";
import common from "../shared/common";
import encryption from "../shared/encryption";

class EmailManager {
    private static instance: EmailManager;
    private client: EmailClient | null = null;
    private constructor() {}

    private async initializeClient() {
        if (this.client) return;
        const connectionStringEncrypted = await common.getAppSetting(
            "COMMUNICATIONSERVICECONNECTIONSTRINGENCRYPTED"
        );
        const connectionString = await encryption.decrypt(
            connectionStringEncrypted
        );
        if (!connectionString) {
            throw new Error(
                "Azure Communication Service connection string is not set."
            );
        }
        this.client = new EmailClient(connectionString);
    }

    async sendLogEmail(
        subject: string,
        body: string,
        waitForConfirmation: boolean = false
    ) {
        const emailFromAddress = await common.getAppSetting(
            "EMAIL_FROM_ADDRESS"
        );
        const emailLogAddress = await common.getAppSetting("EMAIL_LOG_ADDRESS");
        const sender = emailFromAddress;
        const recipients = {
            to: [
                {
                    address: emailLogAddress,
                },
            ],
        };
        await this._sendEmail(
            sender,
            recipients,
            subject,
            body,
            waitForConfirmation
        );
    }

    private async _sendEmail(
        sender: string,
        recipients: EmailRecipients,
        subject: string,
        body: string,
        waitForConfirmation: boolean = false
    ) {
        if (!this.client) await this.initializeClient();
        const emailMessage: EmailMessage = {
            senderAddress: sender,
            recipients: recipients,
            content: {
                subject: subject,
                plainText: body,
            },
        };
        const poller = await this.client?.beginSend(emailMessage);
        if (waitForConfirmation) {
            const response = await poller?.pollUntilDone();
            console.log(`Email sent, message ID: ${response?.id}`);
        }
    }

    public static getInstance(): EmailManager {
        if (!EmailManager.instance) {
            EmailManager.instance = new EmailManager();
        }
        return EmailManager.instance;
    }
}

export default EmailManager.getInstance();
