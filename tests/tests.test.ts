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

    await webhookEngine.initialize();
    await healthFactorCheckEngine.initialize();
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

test("we_manageVariable", { only: false }, async () => {
    const req: any = {
        query: {
            value: "testValue",
            method: "set",
        },
    };
    //key is not defined, should throw an error
    assert.throws(() => webhookEngine.manageVariable(req));

    //key is not present, should throw an error
    req.query.key = "someTestKeyWhichIsNotInPresent";
    assert.throws(() => webhookEngine.manageVariable(req));

    //key is not allowed to be changed, should throw an error
    req.query.key = "addresses";
    assert.throws(() => webhookEngine.manageVariable(req));

    //key is allowed to be changed, should return the value
    req.query.key = "checkReservesPricesIntervalInSeconds";
    req.query.value = 10;
    webhookEngine.manageVariable(req);

    req.query.method = "get";
    assert.strictEqual(webhookEngine.manageVariable(req), 10);
});

test("hf_aaveChainInfosArrayIsDefined", { only: false }, async () => {
    assert.ok(healthFactorCheckEngine.aaveChainsInfos.length > 0);
});

test("hf_initializeHealthFactorEngine", { only: false }, async () => {
    const aaveChainInfo = await healthFactorCheckEngine.getAaveChainInfo("arb");
    const aaveLendingPoolContractAddress =
        aaveChainInfo.aaveLendingPoolContract.target;

    assertStringIsNotNullOrEmpty(aaveLendingPoolContractAddress);

    const dbAddressesArr = await sqlManager.execQuery(
        `SELECT TOP 1 * FROM addresses where chain = 'arb-mainnet';`
    );

    assert.ok(Array.isArray(dbAddressesArr), "Input must be an array");
    assert.ok(dbAddressesArr.length > 0, "Array length must be greater than 0");

    const dbAddress = dbAddressesArr[0];

    assertStringIsNotNullOrEmpty(dbAddress.address);

    const data: any =
        await healthFactorCheckEngine.getUserHealthFactorAndConfiguration(
            dbAddress.address,
            "arb"
        );

    assertStringIsNotNullOrEmpty(data.healthFactor);
    assertStringIsNotNullOrEmpty(data.userConfiguration);

    assert.ok(
        /^[01]*$/.test(data.userConfiguration),
        "String must contain only 0s and 1s"
    );
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
