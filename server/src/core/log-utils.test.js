import test from "node:test";
import assert from "node:assert/strict";
import { shouldRenderLogLine } from "./log-utils.js";

test("hides noisy Claude system events", () => {
    assert.equal(shouldRenderLogLine("ℹ️ thinking_tokens"), false);
    assert.equal(shouldRenderLogLine("ℹ️ init"), false);
    assert.equal(shouldRenderLogLine("ℹ️ post_turn_summary"), false);
});

test("keeps meaningful log events", () => {
    assert.equal(shouldRenderLogLine("💬 hello from agent"), true);
    assert.equal(shouldRenderLogLine("🔧 dùng tool: Bash {\"command\": \"pwd\"}"), true);
    assert.equal(shouldRenderLogLine("✅ Kết quả cuối: done"), true);
    assert.equal(shouldRenderLogLine("⚠️ warning"), true);
});
