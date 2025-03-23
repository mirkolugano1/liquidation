import * as assert from "node:assert/strict";

class TestsCommon {
    private static instance: TestsCommon;
    private constructor() {}

    public assertStringIsNotNullOrEmpty(value: any) {
        if (typeof value !== "string") value = value?.toString();
        assert.ok(value);
        assert.notStrictEqual(value, "");
    }

    public static getInstance(): TestsCommon {
        if (!TestsCommon.instance) {
            TestsCommon.instance = new TestsCommon();
        }
        return TestsCommon.instance;
    }
}

export default TestsCommon.getInstance();
