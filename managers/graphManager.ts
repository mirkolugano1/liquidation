import encryption from "../common/encryption";

import dotenv from "dotenv";
dotenv.config();

class GraphManager {
    private static instance: GraphManager;
    endpoint =
        "https://gateway.thegraph.com/api/{0}/subgraphs/id/Cd2gEDVeqnjBn1hSeqFMitw8Q1iiyV9FYUZkLNRcL87g";
    apiKey: string = "";
    request: any;
    gql: any;

    getQuery(queryType: string) {
        const query = this.queries[queryType];
        if (!query) throw new Error("Unknown query type: " + queryType);
        return query;
    }

    async execQuery(queryType: string, variables: any) {
        if (!this.apiKey) await this.initialize();
        const query = this.getQuery(queryType);
        return await this.request(this.endpoint, query, variables);
    }

    public static getInstance(): GraphManager {
        if (!GraphManager.instance) {
            GraphManager.instance = new GraphManager();
        }
        return GraphManager.instance;
    }

    queries: any = {
        userReserves: "",
    };

    async initialize() {
        const { gql, request } = await import("graphql-request");
        this.request = request;

        this.queries.userReserves = gql`
            query getUserReserves(
                $addresses: [String!]
                $first: Int!
                $skip: Int!
            ) {
                userReserves(
                    where: { user_in: $addresses }
                    first: $first
                    skip: $skip
                ) {
                    user {
                        id
                    }
                    reserve {
                        symbol
                        decimals
                        price {
                            priceInEth
                        }
                        reserveLiquidationThreshold
                    }
                    currentATokenBalance
                    currentVariableDebt
                }
            }
        `;

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
