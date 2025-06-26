import common from "../shared/common";
import Redis from "ioredis";

import dotenv from "dotenv";
import _ from "lodash";
dotenv.config();

class RedisManager {
    private static instance: RedisManager;
    private isInitialized: boolean = false;
    public redisClient: Redis = new Redis();

    public static getInstance(): RedisManager {
        if (!RedisManager.instance) {
            RedisManager.instance = new RedisManager();
        }
        return RedisManager.instance;
    }

    async getMultipleJsonKeys(keys: string[]): Promise<any[]> {
        const values = await this.redisClient.mget(keys);
        return values.map((val) => (val ? JSON.parse(val) : null));
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
            if (!doc || !doc.key) {
                throw new Error("Each object must have a 'key' property.");
            }
            for (const key of keys) {
                pipeline.call(
                    "JSON.SET",
                    doc.key,
                    "$." + key,
                    JSON.stringify(doc[key])
                );
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
    async deleteArrayByQuery(items: any) {
        if (!items) throw new Error("items must be provided");
        if (Array.isArray(items) && items.length === 0)
            throw new Error("items must be a non-empty array.");
        if (!Array.isArray(items)) items = [items];

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
        if (command === "FT.SEARCH" && !_.includes(args, "LIMIT")) {
            args.push("LIMIT", 0, 10000);
        }
        const results: any = await this.redisClient.call(command, ...args);
        return this.parseSearchResults(results);
    }

    async deleteAllIndexes() {
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
            console.log(
                `Searching for documents matching: ${query.substring(0, 50)}...`
            );

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
        const result: any = await this.redisClient.call("JSON.GET", key, "$");
        return result ? JSON.parse(result)[0] : null;
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
            pipeline.call("JSON.GET", key, "$");
        });

        const results: any = await pipeline.exec();
        if (!results) return [];

        // Process results
        const data = results
            .map((result: any, index: number) => {
                if (result[0]) {
                    // Error occurred
                    console.error(`Error getting ${keys[index]}:`, result[0]);
                    return null;
                }

                // Parse JSON result
                try {
                    return JSON.parse(result[1])[0]; // result[1][0] contains the JSON string
                } catch (error) {
                    console.error(
                        `Error parsing JSON for ${keys[index]}:`,
                        error
                    );
                    return null;
                }
            })
            .filter((item: any) => item !== null); // Remove failed items

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
            const key = results[i];
            const docArray = results[i + 1];

            if (Array.isArray(docArray)) {
                // Find the "$" entry in the array and parse its JSON string
                const dollarIdx = docArray.indexOf("$");
                if (
                    dollarIdx !== -1 &&
                    typeof docArray[dollarIdx + 1] === "string"
                ) {
                    try {
                        const docData = JSON.parse(docArray[dollarIdx + 1]);
                        documents.push({
                            key: key,
                            ...docData,
                        });
                    } catch (e) {
                        // If JSON parsing fails, fallback to including raw data
                        documents.push({
                            key: key,
                            raw: docArray,
                        });
                    }
                } else {
                    // Fallback: map field-value pairs
                    const docObj: any = { key };
                    for (let j = 0; j < docArray.length; j += 2) {
                        docObj[docArray[j]] = docArray[j + 1];
                    }
                    documents.push(docObj);
                }
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
                await this.setDataByType(pipeline, keys[i], data[i]);
            }
            await pipeline.exec();
        } else {
            await this.setDataByType(this.redisClient, keys, data);
        }
    }

    private async setDataByType(
        client: any,
        key: string,
        data: any
    ): Promise<void> {
        // Determine data type and storage method
        if (data === null || data === undefined) {
            // Store null/undefined as JSON
            await client.call("JSON.SET", key, "$", JSON.stringify(null));
        } else if (Array.isArray(data)) {
            // Arrays: Store as JSON for complex arrays, or LIST for simple arrays
            if (this.isSimpleArray(data)) {
                // Simple array of primitives - can use LIST
                await client.del(key); // Clear existing data
                if (data.length > 0) {
                    await client.rpush(
                        key,
                        ...data.map((item) => String(item))
                    );
                }
            } else {
                // Complex array with objects - use JSON
                await client.call("JSON.SET", key, "$", JSON.stringify(data));
            }
        } else if (typeof data === "object") {
            // Objects: Always store as JSON (not HASH)
            try {
                await client.call("JSON.SET", key, "$", JSON.stringify(data));
            } catch (error) {
                console.error(`Error setting key ${key}:`, data);
                throw new Error(`Failed to set key ${key}`);
            }
        } else if (typeof data === "string") {
            // Strings: Check if it's JSON string or plain string
            if (this.isJsonString(data)) {
                // It's a JSON string, store as JSON
                await client.call("JSON.SET", key, "$", data);
            } else {
                // Plain string, store as STRING
                await client.set(key, data);
            }
        } else if (typeof data === "number" || typeof data === "boolean") {
            // Primitives: Store as JSON to maintain type
            await client.set(key, String(data));
        } else {
            // Fallback: Convert to JSON
            await client.call("JSON.SET", key, "$", JSON.stringify(data));
        }
    }

    private isSimpleArray(arr: any[]): boolean {
        // Check if array contains only primitives (not objects)
        return arr.every(
            (item) =>
                typeof item === "string" ||
                typeof item === "number" ||
                typeof item === "boolean" ||
                item === null
        );
    }

    private isJsonString(str: string): boolean {
        try {
            JSON.parse(str);
            return str.trim().startsWith("{") || str.trim().startsWith("[");
        } catch {
            return false;
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

        const indexes: any = await this.redisClient.call("FT._LIST");
        if (indexes.length === 0) {
            console.log("No indexes found in Redis. Creating indexes...");
            await this.createRedisIndexes();
            console.log("Successfully created indexes in redis");
        }

        this.isInitialized = true;
    }

    async createRedisIndexes(overwriteIndexes: boolean = false) {
        //create indexes in Redis
        if (overwriteIndexes) await this.deleteAllIndexes();

        await this.redisClient.call(
            "FT.CREATE",
            "idx:usersReserves",
            "ON",
            "JSON",
            "PREFIX",
            "1",
            "usersReserves:",
            "SCHEMA",
            "$.network",
            "AS",
            "network",
            "TAG",
            "$.networkNormalized",
            "AS",
            "networkNormalized",
            "TAG",
            "$.address",
            "AS",
            "address",
            "TAG",
            "$.tokenAddress",
            "AS",
            "tokenAddress",
            "TAG",
            "$.currentATokenBalance",
            "AS",
            "currentATokenBalance",
            "NUMERIC",
            "$.currentStableDebt",
            "AS",
            "currentStableDebt",
            "NUMERIC",
            "$.currentVariableDebt",
            "AS",
            "currentVariableDebt",
            "NUMERIC",
            "$.principalStableDebt",
            "AS",
            "principalStableDebt",
            "NUMERIC",
            "$.scaledVariableDebt",
            "AS",
            "scaledVariableDebt",
            "NUMERIC",
            "$.stableBorrowRate",
            "AS",
            "stableBorrowRate",
            "NUMERIC",
            "$.liquidityRate",
            "AS",
            "liquidityRate",
            "NUMERIC",
            "$.stableRateLastUpdated",
            "AS",
            "stableRateLastUpdated",
            "NUMERIC",
            "$.usageAsCollateralEnabled",
            "AS",
            "usageAsCollateralEnabled",
            "TAG",
            "$.modifiedOn",
            "AS",
            "modifiedOn",
            "NUMERIC"
        );

        await this.redisClient.call(
            "FT.CREATE",
            "idx:reserves",
            "ON",
            "JSON",
            "PREFIX",
            "1",
            "reserves:",
            "SCHEMA",
            "$.network",
            "AS",
            "network",
            "TAG",
            "$.networkNormalized",
            "AS",
            "networkNormalized",
            "TAG",
            "$.address",
            "AS",
            "address",
            "TAG",
            "$.symbol",
            "AS",
            "symbol",
            "TAG",
            "$.decimals",
            "AS",
            "decimals",
            "NUMERIC",
            "$.reserveLiquidationThreshold",
            "AS",
            "reserveLiquidationThreshold",
            "NUMERIC",
            "$.reserveLiquidationBonus",
            "AS",
            "reserveLiquidationBonus",
            "NUMERIC",
            "$.reserveFactor",
            "AS",
            "reserveFactor",
            "NUMERIC",
            "$.usageAsCollateralEnabled",
            "AS",
            "usageAsCollateralEnabled",
            "TAG",
            "$.borrowingEnabled",
            "AS",
            "borrowingEnabled",
            "TAG",
            "$.stableBorrowRateEnabled",
            "AS",
            "stableBorrowRateEnabled",
            "TAG",
            "$.isActive",
            "AS",
            "isActive",
            "TAG",
            "$.isFrozen",
            "AS",
            "isFrozen",
            "TAG",
            "$.liquidityIndex",
            "AS",
            "liquidityIndex",
            "NUMERIC",
            "$.variableBorrowIndex",
            "AS",
            "variableBorrowIndex",
            "NUMERIC",
            "$.liquidityRate",
            "AS",
            "liquidityRate",
            "NUMERIC",
            "$.variableBorrowRate",
            "AS",
            "variableBorrowRate",
            "NUMERIC",
            "$.lastUpdateTimestamp",
            "AS",
            "lastUpdateTimestamp",
            "NUMERIC",
            "$.aTokenAddress",
            "AS",
            "aTokenAddress",
            "TAG",
            "$.totalStableDebt",
            "AS",
            "totalStableDebt",
            "NUMERIC",
            "$.totalVariableDebt",
            "AS",
            "totalVariableDebt",
            "NUMERIC",
            "$.ltv",
            "AS",
            "ltv",
            "NUMERIC",
            "$.price",
            "AS",
            "price",
            "NUMERIC",
            "$.variableDebtTokenAddress",
            "AS",
            "variableDebtTokenAddress",
            "TAG",
            "$.stableDebtTokenAddress",
            "AS",
            "stableDebtTokenAddress",
            "TAG",
            "$.sorting",
            "AS",
            "sorting",
            "NUMERIC",
            "$.modifiedOn",
            "AS",
            "modifiedOn",
            "NUMERIC",
            "$.priceModifiedOn",
            "AS",
            "priceModifiedOn",
            "NUMERIC",
            "$.liquidationProtocolFee",
            "AS",
            "liquidationProtocolFee",
            "NUMERIC",
            "$.priceOracleAggregatorAddress",
            "AS",
            "priceOracleAggregatorAddress",
            "TAG"
        );

        await this.redisClient.call(
            "FT.CREATE",
            "idx:addresses",
            "ON",
            "JSON",
            "PREFIX",
            "1",
            "addresses:",
            "SCHEMA",
            "$.network",
            "AS",
            "network",
            "TAG",
            "$.networkNormalized",
            "AS",
            "networkNormalized",
            "TAG",
            "$.address",
            "AS",
            "address",
            "TAG",
            "$.healthFactor",
            "AS",
            "healthFactor",
            "NUMERIC",
            "$.totalDebtBase",
            "AS",
            "totalDebtBase",
            "NUMERIC",
            "$.totalCollateralBase",
            "AS",
            "totalCollateralBase",
            "NUMERIC",
            "$.currentLiquidationThreshold",
            "AS",
            "currentLiquidationThreshold",
            "NUMERIC",
            "$.addedOn",
            "AS",
            "addedOn",
            "NUMERIC",
            "$.modifiedOn",
            "AS",
            "modifiedOn",
            "NUMERIC",
            "$.userConfiguration",
            "AS",
            "userConfiguration",
            "TAG",
            "$.status",
            "AS",
            "status",
            "NUMERIC"
        );
    }
}

export default RedisManager.getInstance();
