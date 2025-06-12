import common from "../shared/common";
import Redis from "ioredis";

import dotenv from "dotenv";
import _ from "lodash";
dotenv.config();

class RedisManager {
    private static instance: RedisManager;
    private redisClient: Redis = new Redis();
    private isInitialized: boolean = false;

    public static getInstance(): RedisManager {
        if (!RedisManager.instance) {
            RedisManager.instance = new RedisManager();
        }
        return RedisManager.instance;
    }

    /**
    /* Sets properties of multiple objects in Redis.
    /* The properties must be specified in the objectsArray and must already contain the correct value.
    /* @param objectsArray - Array of objects to update.
    /* @param keys - The keys of the properties to update.
    /* @returns Promise<void>
    */
    async setArrayProperties(objectsArray: any[], keys: string | string[]) {
        if (!Array.isArray(objectsArray) || objectsArray.length === 0) {
            throw new Error("objectsArray must be a non-empty array.");
        }
        if (!keys || (Array.isArray(keys) && keys.length === 0)) {
            throw new Error(
                "keys must be a non-empty string or array of strings."
            );
        }
        if (typeof keys === "string") {
            keys = [keys];
        }
        await this.initialize();
        const pipeline = this.redisClient.pipeline();
        for (const doc of objectsArray) {
            for (const key of keys) {
                pipeline.call("JSON.SET", doc.key, "$." + key, doc[key]);
            }
        }
        await pipeline.exec();
    }

    /**
     * Deletes multiple keys from Redis.
     * @param items - Array of objects containing the keys to delete.
     * * Each object should have a 'key' property.
     * @returns Promise<void>
     */
    async deleteArrayByQuery(items: any[]) {
        const pipeline = this.redisClient.pipeline();
        for (const item of items) {
            pipeline.del(item.key);
        }
        await pipeline.exec();
    }

    async call(
        command: string,
        ...args: (string | number | Buffer<ArrayBufferLike>)[]
    ) {
        await this.initialize();
        const results: any = await this.redisClient.call(command, ...args);
        return this.parseSearchResults(results);
    }

    async deleteAllIndexes() {
        await this.initialize();
        console.log("Deleting all indexes...");
        try {
            // Get list of all indexes
            const indexes: any = await this.redisClient.call("FT._LIST");

            if (indexes.length === 0) {
                console.log("No indexes found");
                return;
            }

            // Delete each index
            for (const indexName of indexes) {
                await this.redisClient.call("FT.DROPINDEX", indexName);
                console.log(`Deleted index: ${indexName}`);
            }

            console.log("All indexes deleted successfully");
        } catch (error) {
            console.error("Error deleting indexes:", error);
        }
    }

    //**
    /* Deletes documents from a Redisearch index based on a query.
    /* Usage examples:
    /* //Delete addresses where healthFactor > 2
    /* await deleteByQuery('idx:addresses', '@healthFactor:[2 +inf]');
    /* Delete all addresses on a specific network
    /* await deleteByQuery('idx:addresses', '@network:{mainnet}');
    /* Delete user reserves with principalBalance < 10
    /* await deleteByQuery('idx:usersReserves', '@principalBalance:[-inf 10]');
    /* Delete all documents (equivalent to DELETE *)
    /* await deleteByQuery('idx:addresses', '*');
    /* @param indexName - The name of the Redisearch index.
    /* @param query - The query string to match documents for deletion.
    /* @returns The number of documents deleted.
    */
    async deleteByQuery(indexName: string, query: string) {
        await this.initialize();
        if (!indexName || !query) {
            throw new Error("Both indexName and query must be provided");
        }
        try {
            console.log(`Searching for documents matching: ${query}`);

            // Step 1: Search for matching documents
            // FT.SEARCH returns: [count, key1, doc1, key2, doc2, ...]
            const searchResults: any = await this.redisClient.call(
                "FT.SEARCH",
                "idx:" + indexName,
                query
            );

            if (searchResults[0] === 0) {
                console.log("No documents found matching the query");
                return 0;
            }

            // Step 2: Extract document keys (every second element starting from index 1)
            const keysToDelete = [];
            for (let i = 1; i < searchResults.length; i += 2) {
                keysToDelete.push(searchResults[i]);
            }

            console.log(`Found ${keysToDelete.length} documents to delete`);

            // Step 3: Delete the documents
            if (keysToDelete.length > 0) {
                const deletedCount = await this.redisClient.del(
                    ...keysToDelete
                );
                console.log(`Successfully deleted ${deletedCount} documents`);
                return deletedCount;
            }

            return 0;
        } catch (error) {
            console.error("Error during delete operation:", error);
            throw error;
        }
    }

    async deleteAllData() {
        await this.initialize();
        await this.redisClient.flushall();
    }

    /**
     * Retrieves the value of a key from Redis.
     * If properties are provided, it retrieves specific property or properties from a hash using appropriate Redis commands.
     * If no properties are provided, it retrieves the "string | null" value of the key directly.
     *
     * @param key
     * @param properties
     * @returns value of the key or specific properties if provided
     */
    async getValue(key: string, ...properties: string[]): Promise<any> {
        await this.initialize();
        if (properties.length > 0) {
            if (properties.length == 1)
                return await this.redisClient.hget(key, properties[0]);
            if (Array.isArray(properties))
                return await this.redisClient.hmget(key, ...properties);
        }
        return await this.redisClient.get(key);
    }

    async getObject(key: string): Promise<any> {
        await this.initialize();
        return await this.redisClient.hgetall(key);
    }

    async getArrayValue(key: string): Promise<any[]> {
        await this.initialize();
        return await this.redisClient.lrange(key, 0, -1);
    }

    async getList(
        keysQuery: string,
        sortBy?: string,
        sortOrder: "ASC" | "DESC" = "ASC"
    ): Promise<any> {
        await this.initialize();
        const keys = await this.redisClient.keys(keysQuery);
        const pipeline = this.redisClient.pipeline();

        keys.forEach((key) => {
            pipeline.hgetall(key);
        });

        const result = await pipeline.exec();
        const data = _.map(result, (item) => {
            if (Array.isArray(item) && item[1]) {
                return item[1];
            }
            return null;
        }).filter((item) => item !== null);

        // Sort if sortBy field is provided
        if (sortBy && data.length > 0) {
            return data.sort((a: any, b: any) => {
                let aVal = a[sortBy];
                let bVal = b[sortBy];

                // Handle numeric values
                if (!isNaN(aVal) && !isNaN(bVal)) {
                    aVal = parseFloat(aVal);
                    bVal = parseFloat(bVal);
                }

                // Handle dates (if they're timestamps)
                if (sortBy.includes("Date") || sortBy.includes("On")) {
                    aVal = new Date(aVal).getTime();
                    bVal = new Date(bVal).getTime();
                }

                if (sortOrder === "ASC") {
                    return aVal > bVal ? 1 : aVal < bVal ? -1 : 0;
                } else {
                    return aVal < bVal ? 1 : aVal > bVal ? -1 : 0;
                }
            });
        }

        return data;
    }

    parseSearchResults(results: any[]): any[] {
        if (!Array.isArray(results) || results.length === 0) {
            return [];
        }

        const documents = [];

        // Skip the count (first element) and process pairs
        for (let i = 1; i < results.length; i += 2) {
            const key = results[i]; // Redis key
            const docArray = results[i + 1]; // Document data

            if (Array.isArray(docArray) && docArray[0] === "$") {
                // JSON document - parse the JSON string
                const docData = JSON.parse(docArray[1]);
                documents.push({
                    key: key,
                    ...docData,
                });
            }
        }

        return documents;
    }

    async set(keys: string | string[], data: any): Promise<void> {
        await this.initialize();
        if (Array.isArray(keys)) {
            if (keys.length !== data.length) {
                throw new Error(
                    "Keys and data arrays must have the same length."
                );
            }
            const pipeline = this.redisClient.pipeline();
            for (let i = 0; i < keys.length; i++) {
                if (Array.isArray(data[i])) pipeline.rpush(keys[i], ...data[i]);
                else if (typeof data !== "object")
                    pipeline.set(keys[i], data[i]);
                else pipeline.hmset(keys[i], data[i]);
            }
            await pipeline.exec();
        } else {
            if (Array.isArray(data)) this.redisClient.rpush(keys, ...data);
            else if (typeof data !== "object")
                await this.redisClient.set(keys, data);
            else await this.redisClient.hmset(keys, data);
        }
    }

    public async initialize() {
        if (this.isInitialized) return;
        const redisServer = await common.getAppSetting("REDISSERVER");
        const redisPort = await common.getAppSetting("REDISPORT");

        if (!redisServer) {
            throw new Error("REDISSERVER is not set in app settings.");
        }

        this.redisClient = new Redis({
            port: redisPort ? parseInt(redisPort) : 6379, // Default Redis port
            host: redisServer,
            // password: 'your-password', // If you've set a password
            // db: 0 // Default Redis DB
        });

        this.isInitialized = true;
    }
}

export default RedisManager.getInstance();
