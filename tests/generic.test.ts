import healthFactorCheckEngine from "../engines/healthFactorCheckEngine";
import * as assert from "node:assert/strict";

function testSimple() {
    // Test case 1: Basic addition
    assert.strictEqual(2 + 3, 5, "2 + 3 should be 5");
}

async function testHealthFactorCheckEngineInitialization() {
    // Test case 1: Initialize healthFactorCheckEngine
    healthFactorCheckEngine.initializeHealthFactorEngine();
    const aaveLendingPoolContractAddress =
        await healthFactorCheckEngine.getAaveChainInfo("arb")
            .aaveLendingPoolContract.target;

    assert.ok(aaveLendingPoolContractAddress);
    assert.notStrictEqual(aaveLendingPoolContractAddress, "");
}

(async () => {
    testSimple();
    await testHealthFactorCheckEngineInitialization();
})();
