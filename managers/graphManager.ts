import encryption from "../common/encryption";

const { request } = require("graphql-request");
require("dotenv").config();

class GraphManager {
    private static instance: GraphManager;
    endpoint =
        "https://gateway.thegraph.com/api/{0}/subgraphs/id/Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g";
    apiKey: string = "";

    async execQuery(query: string) {
        if (!this.apiKey) await this.initialize();
        try {
            return await request(this.endpoint, query);
        } catch (error) {
            console.error("Error fetching user reserves:", error);
        }
    }

    public static getInstance(): GraphManager {
        if (!GraphManager.instance) {
            GraphManager.instance = new GraphManager();
        }
        return GraphManager.instance;
    }

    async initialize() {
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
