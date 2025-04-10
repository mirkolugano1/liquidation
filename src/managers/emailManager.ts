import {
    EmailClient,
    EmailMessage,
    EmailRecipients,
} from "@azure/communication-email";
import common from "../shared/common";

class EmailManager {
    private static instance: EmailManager;
    private client: EmailClient | null = null;
    private constructor() {}

    async initializeClient() {
        if (this.client) return;
        const connectionString =
            process.env.AZURE_COMMUNICATION_SERVICE_CONNECTION_STRING;
        if (!connectionString) {
            throw new Error(
                "Azure Communication Service connection string is not set."
            );
        }
        this.client = new EmailClient(connectionString);
    }

    async sendLogEmail(subject: string, body: string) {
        const emailLogAddress = await common.getAppSetting("EMAIL_LOG_ADDRESS");
        const sender = emailLogAddress;
        const recipients = {
            to: [
                {
                    address: emailLogAddress,
                },
            ],
        };
        await this.sendEmail(sender, recipients, subject, body);
    }

    async sendEmail(
        sender: string,
        recipients: EmailRecipients,
        subject: string,
        body: string
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
        await this.client?.beginSend(emailMessage);
    }

    public static getInstance(): EmailManager {
        if (!EmailManager.instance) {
            EmailManager.instance = new EmailManager();
        }
        return EmailManager.instance;
    }
}

export default EmailManager.getInstance();
