import _ from "lodash";
import dotenv from "dotenv";
import logger from "../shared/logger";
import healthFactorCheckEngine from "../engines/healthFactorCheckEngine";
import common from "../shared/common";
import encryption from "../shared/encryption";
import { application } from "express";
import * as applicationInsights from "applicationinsights";

dotenv.config();

logger.initialize("sandbox");

async function main() {
    //test
    /*
    const pwdEncrypted =
        "tDS1H0NvEBRH98ceM/CF6iBIF7F6Ss6Elxqwxinnv0A1i6TTRdYmk1nGfyaNfjvxPtKWv3IfV65JgCVC9eah3LKlzVtrTbf9YR+vlB9UJU6EUsFEruT+gTfJN8CROgdzp+K2gYt4qk9hxQG8IVLvruxVS3dqsTODbD6aIrNVAgJCcDZ6DOR6CZmqHvNVHhzCHKpByCAk3YyzyF1CYNYYbRsQrL6SPGBPBo39jnAdLBB8vpDkrP7W7JTqcx1y8KtnDTLbxlaP6I/lq4RaIQDsY4mIyouV6SY9YZRa2LoY3ya0O5FziGwLiGysl5TgxVo2FfkuCvQt9hIX5LtxJbqEZA==";
    */
    /*
    const pwd = "teststring";
    const encrypted = await encryption.encrypt(pwd);
    console.log("encrypted", encrypted);
    const decrypted = await encryption.decrypt(encrypted);
    console.log("decrypted", decrypted);
*/
    /*
    logger.setOutputTypeHTML();
    const logs = await logger.viewLogs();
    console.log("logs", logs);
    */
    //await healthFactorCheckEngine.startCheckReservesPrices();
    /*
    applicationInsights.setup(); //.start();
    const client = applicationInsights.defaultClient;
    client.trackEvent({
        name: "testEvent",
        properties: { customProperty: "customValue" },
    });
    await client.flush();
    */
}

main();
