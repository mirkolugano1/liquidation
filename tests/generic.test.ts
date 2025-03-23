import healthFactorCheckEngine from "../engines/healthFactorCheckEngine";
import sqlManager from "../managers/sqlManager";
import testsCommon from "./testsCommon";
import * as assert from "node:assert/strict";
import { test } from "node:test";

test("Test simple addition", () => {
    // Test case 1: Basic addition
    assert.strictEqual(2 + 3, 5, "2 + 3 should be 5");
});

test("Test healthFactorCheckEngine initialization, load from db and get useraccountdata and configuration", async () => {
    // Test case 1: Initialize healthFactorCheckEngine
    await healthFactorCheckEngine.initializeHealthFactorEngine();
    const aaveChainInfo = await healthFactorCheckEngine.getAaveChainInfo("arb");
    const aaveLendingPoolContractAddress =
        aaveChainInfo.aaveLendingPoolContract.target;

    testsCommon.assertStringIsNotNullOrEmpty(aaveLendingPoolContractAddress);

    const dbAddressesArr = await sqlManager.execQuery(
        `SELECT TOP 1 * FROM addresses where chain = 'arb-mainnet';`
    );
    const dbAddress = dbAddressesArr[0];

    testsCommon.assertStringIsNotNullOrEmpty(dbAddress.address);

    const data: any =
        await healthFactorCheckEngine.getUserHealthFactorAndConfiguration(
            dbAddress.address,
            "arb"
        );

    testsCommon.assertStringIsNotNullOrEmpty(data.healthFactor);
    testsCommon.assertStringIsNotNullOrEmpty(data.userConfiguration);
});
