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

    async getValue(
        key: string,
        properties: string | string[] | null = null
    ): Promise<any> {
        await this.initialize();
        if (properties) {
            if (typeof properties === "string")
                return await this.redisClient.hget(key, properties);
            if (Array.isArray(properties))
                return await this.redisClient.hmget(key, ...properties);
        }
        return await this.redisClient.get(key);
    }

    async getObject(key: string): Promise<any> {
        await this.initialize();
        return await this.redisClient.hgetall(key);
    }

    async getArray(key: string): Promise<any[]> {
        await this.initialize();
        return await this.redisClient.lrange(key, 0, -1);
    }

    async getMultiple(keysQuery: string): Promise<any> {
        await this.initialize();
        const keys = await this.redisClient.keys(keysQuery);
        const pipeline = this.redisClient.pipeline();

        keys.forEach((key) => {
            pipeline.hgetall(key);
        });

        const result = await pipeline.exec();
        return _.map(result, (item) => {
            if (Array.isArray(item) && item[1]) {
                return item[1]; // Return the value part of the array
            }
            return null; // Handle cases where the key does not exist
        });
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

        this.redisClient.on("connect", () => {
            console.log("Connected to Redis");
        });

        this.redisClient.on("error", (err) => {
            console.error("Redis connection error:", err);
        });
        this.isInitialized = true;
    }
}

export default RedisManager.getInstance();
