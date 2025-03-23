import healthFactorCheckEngine from "../engines/healthFactorCheckEngine";
import sqlManager from "../managers/sqlManager";
import testsCommon from "./testsCommon";
import * as assert from "node:assert/strict";
import { before, test } from "node:test";

//code that runs once before all tests.
before(async () => {
    await healthFactorCheckEngine.initializeHealthFactorEngine();
});

test("Test healthFactorCheckEngine initialization, load from db and get useraccountdata and configuration", async () => {
    const aaveChainInfo = await healthFactorCheckEngine.getAaveChainInfo("arb");
    const aaveLendingPoolContractAddress =
        aaveChainInfo.aaveLendingPoolContract.target;

    testsCommon.assertStringIsNotNullOrEmpty(aaveLendingPoolContractAddress);

    const dbAddressesArr = await sqlManager.execQuery(
        `SELECT TOP 1 * FROM addresses where chain = 'arb-mainnet';`
    );

    assert.ok(Array.isArray(dbAddressesArr), "Input must be an array");
    assert.ok(dbAddressesArr.length > 0, "Array length must be greater than 0");

    const dbAddress = dbAddressesArr[0];

    testsCommon.assertStringIsNotNullOrEmpty(dbAddress.address);

    const data: any =
        await healthFactorCheckEngine.getUserHealthFactorAndConfiguration(
            dbAddress.address,
            "arb"
        );

    testsCommon.assertStringIsNotNullOrEmpty(data.healthFactor);
    testsCommon.assertStringIsNotNullOrEmpty(data.userConfiguration);

    assert.ok(
        /^[01]*$/.test(data.userConfiguration),
        "String must contain only 0s and 1s"
    );
});
