import test from "node:test";
import assert from "node:assert/strict";
import { buildSpawnedAgent, checkSpawnLimits, spawnedTokens, normalizeSpawnPolicy } from "./spawn-policy.js";
import { KNOWN_TOOLS } from "../../core/config.js";

const policy = normalizeSpawnPolicy({
  enabled: true,
  providers: ["claude", "codex", "gemini"],
  claudeModels: ["sonnet"],
  geminiModels: ["gemini-3.8-flash-low"],
  maxAgents: 2,
  tokenBudget: 1000,
});
const supervisor = { provider: "claude", accessLevel: "write", allowedTools: ["Read", "Grep", "Edit", "Task"] };

test("provider must be on the whitelist, and is required when several are allowed", () => {
  assert.throws(() => buildSpawnedAgent(policy, supervisor, { provider: "other" }), /không nằm trong danh sách/);
  assert.throws(() => buildSpawnedAgent(policy, supervisor, {}), /Cần chọn provider/);
  assert.equal(buildSpawnedAgent({ ...policy, providers: ["codex"] }, supervisor, {}).provider, "codex");
});

test("model must be the CLI default or on the provider's whitelist", () => {
  assert.equal(buildSpawnedAgent(policy, supervisor, { provider: "claude", model: "sonnet" }).model, "sonnet");
  assert.equal(buildSpawnedAgent(policy, supervisor, { provider: "claude" }).model, "");
  assert.throws(() => buildSpawnedAgent(policy, supervisor, { provider: "claude", model: "opus" }), /không được phép/);
  assert.equal(buildSpawnedAgent(policy, supervisor, { provider: "gemini", model: "gemini-3.8-flash-low" }).model, "gemini-3.8-flash-low");
});

test("a child's access level defaults to read and never exceeds the supervisor's", () => {
  const read = buildSpawnedAgent(policy, supervisor, { provider: "codex" });
  assert.equal(read.accessLevel, "read");
  assert.equal(read.codexSandbox, "read-only");
  const write = buildSpawnedAgent(policy, supervisor, { provider: "gemini", accessLevel: "write" });
  assert.equal(write.agyMode, "accept-edits");
  assert.throws(() => buildSpawnedAgent(policy, supervisor, { provider: "codex", accessLevel: "full" }), /không được có quyền cao hơn/);
  assert.throws(
    () => buildSpawnedAgent(policy, { ...supervisor, accessLevel: "read" }, { provider: "claude", accessLevel: "write" }),
    /không được có quyền cao hơn/
  );
});

test("claude child tools stay inside the supervisor's allowlist and never include Task", () => {
  const omitted = buildSpawnedAgent(policy, supervisor, { provider: "claude" });
  assert.deepEqual(omitted.allowedTools, ["Read", "Grep", "Edit"], "Task is dropped from the ceiling");
  assert.deepEqual(omitted.disallowedTools, KNOWN_TOOLS.filter((t) => !["Read", "Grep", "Edit"].includes(t)));
  assert.equal(omitted.permissionMode, "default", "level read by default (write tools are blocked at spawn time)");

  assert.throws(() => buildSpawnedAgent(policy, supervisor, { provider: "claude", tools: ["Bash"] }), /vượt quá quyền/);
  assert.throws(() => buildSpawnedAgent(policy, supervisor, { provider: "claude", tools: ["Task"] }), /Task/);

  const none = buildSpawnedAgent(policy, supervisor, { provider: "claude", tools: [] });
  assert.deepEqual(none.disallowedTools, KNOWN_TOOLS, "no tools chosen = every tool denied, not unrestricted");

  // a codex/agy supervisor has no Claude allowlist: its level decides
  const codexSup = { provider: "codex", accessLevel: "read" };
  assert.deepEqual(buildSpawnedAgent(policy, codexSup, { provider: "claude" }).allowedTools, ["Read", "Grep", "Glob", "WebFetch", "WebSearch"]);
});

test("agent count includes running spawns; token budget counts finished ones", () => {
  const spawnTask = (usage, status = "done") => ({ kind: "agent-spawn", status, usage });
  const run = { tasks: [{ kind: "agent", usage: { inputTokens: 99999, outputTokens: 0 } }] };
  assert.doesNotThrow(() => checkSpawnLimits(run, policy), "non-spawn tasks don't count");

  run.tasks.push(spawnTask(null, "running"));
  assert.doesNotThrow(() => checkSpawnLimits(run, policy));
  run.tasks.push(spawnTask(null, "running"));
  assert.throws(() => checkSpawnLimits(run, policy), /Đã tạo đủ 2 agent/);

  const budgetRun = { tasks: [spawnTask({ inputTokens: 400, outputTokens: 300, cacheCreationTokens: 300, cacheReadTokens: 5000 })] };
  assert.equal(spawnedTokens(budgetRun), 1000);
  assert.throws(() => checkSpawnLimits(budgetRun, { ...policy, maxAgents: 10 }), /ngân sách token/);
  assert.doesNotThrow(() => checkSpawnLimits(budgetRun, { ...policy, maxAgents: 10, tokenBudget: 0 }), "0 = no budget");
});
