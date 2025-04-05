import healthFactorCheckEngine from "../src/engines/healthFactorCheckEngine";
import webhookEngine from "../src/engines/webhookEngine";
import sqlManager from "../src/managers/sqlManager";
import * as assert from "node:assert/strict";
import { before, test } from "node:test";
import logger from "../src/shared/logger";
import dotenv from "dotenv";
import encryption from "../src/shared/encryption";

function assertStringIsNotNullOrEmpty(value: any) {
    if (typeof value !== "string") value = value?.toString();
    assert.ok(value);
    assert.notStrictEqual(value, "");
}

//code that runs once before all tests.
before(async () => {
    dotenv.config();
    logger.initialize("test");

    //setting the environment variables
    //these are the ones that are in the .env file, which are not very sensitive
    process.env.LIQUIDATIONENVIRONMENT = "prod";

    await healthFactorCheckEngine.initializeAlchemy();
});

test("encryption_testEncryptDecrypt", { only: false }, async () => {
    const text = Math.random().toString();
    const encrypted1 = await encryption.encryptWithKey(text);
    const decrypted1 = await encryption.decryptWithKey(encrypted1);
    assert.strictEqual(text, decrypted1);

    const encrypted2 = await encryption.encrypt(text);
    const decrypted2 = await encryption.decrypt(encrypted2);
    assert.strictEqual(text, decrypted2);
});

test("hf_initializeHealthFactorEngine", { only: true }, async () => {
    const aaveChainInfo = await healthFactorCheckEngine.getAaveChainInfo("arb");
    const aaveLendingPoolContractAddress = aaveChainInfo.addresses.pool;

    assertStringIsNotNullOrEmpty(aaveLendingPoolContractAddress);

    const dbAddressesArr = await sqlManager.execQuery(
        `SELECT TOP 1 * FROM addresses where chain = 'arb-mainnet';`
    );

    assert.ok(Array.isArray(dbAddressesArr), "Input must be an array");
    assert.ok(dbAddressesArr.length > 0, "Array length must be greater than 0");

    const dbAddress = dbAddressesArr[0];

    assertStringIsNotNullOrEmpty(dbAddress.address);
});

test("logger_logsCorrectly", { only: false }, async () => {
    const text = Math.random().toString();
    logger.useTableLogging();
    await logger.log(text, "test");
    const result = await sqlManager.execQuery(
        "SELECT TOP 1 * FROM dbo.logs WHERE loglevel = 'test' ORDER BY timestamp DESC"
    );
    assert.ok(result.length > 0);
    assert.strictEqual(result[0].log, text);
});
