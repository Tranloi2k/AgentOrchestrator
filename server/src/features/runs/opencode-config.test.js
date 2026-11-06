import test from "node:test";
import assert from "node:assert/strict";
import { OPENROUTER_KEY_ENV, buildOpenCodeConfig, opencodeModelId, opencodePermission, addOpenCodeUsage } from "./opencode-config.js";

test("the key is referenced from the environment, never written into the config", () => {
  const config = buildOpenCodeConfig({ accessLevel: "read" });
  assert.equal(config.provider.openrouter.options.apiKey, `{env:${OPENROUTER_KEY_ENV}}`);
  assert.doesNotMatch(JSON.stringify(config), /sk-or-/);
});

test("permissions follow the access level, and nothing is left to ask", () => {
  const read = opencodePermission("read");
  assert.equal(read.edit, "deny");
  assert.equal(read.bash, "deny");
  assert.equal(read.read["*.env"], "deny");
  const write = opencodePermission("write");
  assert.equal(write.edit, "allow");
  assert.equal(write.bash, "allow");
  assert.equal(write.external_directory, "deny");
  assert.equal(opencodePermission("full")["*"], "allow");
  assert.deepEqual(opencodePermission("bogus"), read, "an unknown level gets the least access");
  for (const level of ["read", "write", "full"]) assert.doesNotMatch(JSON.stringify(opencodePermission(level)), /"ask"/);
});

test("system prompt file and agent-bridge MCP server are wired in only when present", () => {
  assert.equal(buildOpenCodeConfig({ accessLevel: "read" }).instructions, undefined);
  assert.equal(buildOpenCodeConfig({ accessLevel: "read" }).mcp, undefined);
  const config = buildOpenCodeConfig({
    accessLevel: "write",
    instructionsFile: "C:\\tmp\\sys.md",
    bridge: { script: "/srv/mcp-bridge.js", env: { AGENT_BRIDGE_SESSION: "s1" }, timeoutMs: 1000 },
  });
  assert.deepEqual(config.instructions, ["C:/tmp/sys.md"]);
  assert.deepEqual(config.mcp["agent-bridge"], {
    type: "local",
    command: ["node", "/srv/mcp-bridge.js"],
    environment: { AGENT_BRIDGE_SESSION: "s1" },
    enabled: true,
    timeout: 1000,
  });
});

test("model ids always get the openrouter/ provider prefix", () => {
  assert.equal(opencodeModelId("qwen/qwen3-coder:free"), "openrouter/qwen/qwen3-coder:free");
  assert.equal(opencodeModelId("openrouter/auto"), "openrouter/openrouter/auto", "OpenRouter's own router ids start with openrouter/");
  assert.equal(opencodeModelId(""), "");
});

test("usage sums every step_finish; reasoning counts as output", () => {
  const step = (input, output, reasoning, read, cost) => ({ type: "step_finish", part: { tokens: { input, output, reasoning, cache: { read, write: 0 } }, cost } });
  let usage = addOpenCodeUsage(null, { type: "step_start" }, 5);
  assert.equal(usage, null);
  usage = addOpenCodeUsage(usage, step(100, 10, 5, 50, 0.001), 10);
  usage = addOpenCodeUsage(usage, step(20, 3, 0, 80, 0.002), 20);
  assert.deepEqual(usage, {
    provider: "opencode",
    inputTokens: 120,
    outputTokens: 18,
    cacheReadTokens: 130,
    cacheCreationTokens: 0,
    costUsd: 0.003,
    durationMs: 20,
  });
});
