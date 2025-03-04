import encryption from "../common/encryption";

import dotenv from "dotenv";
dotenv.config();

class GraphManager {
    private static instance: GraphManager;
    endpoint =
        "https://gateway.thegraph.com/api/{0}/subgraphs/id/Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g";
    apiKey: string = "";
    request: any;

    async execQuery(query: string) {
        if (!this.apiKey) await this.initialize();
        return await this.request(this.endpoint, query);
    }

    public static getInstance(): GraphManager {
        if (!GraphManager.instance) {
            GraphManager.instance = new GraphManager();
        }
        return GraphManager.instance;
    }

    async initialize() {
        const { request } = await import("graphql-request");
        this.request = request;
        const theGraphApiKeyEncrypted = await encryption.getSecretFromKeyVault(
            "THEGRAPHAPIKEYENCRYPTED"
        );
        const theGraphApiKey = await encryption.decrypt(
            theGraphApiKeyEncrypted
        );
        this.endpoint = this.endpoint.replace("{0}", theGraphApiKey);
    }
}

export default GraphManager.getInstance();
