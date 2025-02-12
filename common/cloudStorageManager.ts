import encryption from "./encryption";

const {
    BlobServiceClient,
    StorageSharedKeyCredential,
} = require("@azure/storage-blob");

export class CloudStorageManager {
    public constructor() {}
    private blockBlobClient: any;
    private accountName: string = "liquidationsa";

    async initializeBlobClient(containerName: string, blobName: string) {
        let accountKey = await encryption.decrypt(
            process.env.CLOUDSTORAGEKEYENCRYPTED!,
            process.env.ENCRYPTIONPWD!
        );

        // Create the BlobServiceClient object
        const blobServiceClient = new BlobServiceClient(
            `https://${this.accountName}.blob.core.windows.net`,
            new StorageSharedKeyCredential(this.accountName, accountKey)
        );

        // Get a reference to the container and the blob
        const containerClient =
            blobServiceClient.getContainerClient(containerName);

        this.blockBlobClient = containerClient.getBlockBlobClient(blobName);
    }

    async readBlob() {
        // Download the blob's content to a buffer
        const downloadBlockBlobResponse = await this.blockBlobClient.download(
            0
        );
        const downloaded = (
            (await this.streamToBuffer(
                downloadBlockBlobResponse.readableStreamBody
            )) as any
        ).toString();

        return downloaded;
    }

    // A helper function to read a readable stream into a buffer
    async streamToBuffer(readableStream: any) {
        return new Promise((resolve, reject) => {
            const chunks: any[] = [];
            readableStream.on("data", (data: any) => chunks.push(data));
            readableStream.on("end", () => resolve(Buffer.concat(chunks)));
            readableStream.on("error", reject);
        });
    }

    async writeBlob(str: string) {
        await this.blockBlobClient.upload(str, str.length);
    }
}
