import test from "node:test";
import assert from "node:assert/strict";
import { buildSpawnedAgent, buildBlueprintAgent, buildInlineBlueprint, checkSpawnLimits, spawnedTokens, normalizeSpawnPolicy, normalizeBlueprints, spawnCeiling } from "./spawn-policy.js";
import { KNOWN_TOOLS } from "../../core/config.js";

const policy = normalizeSpawnPolicy({
  enabled: true,
  providers: ["claude", "codex", "gemini"],
  claudeModels: ["sonnet"],
  geminiModels: ["gemini-3.8-flash-low"],
  maxAgents: 2,
  tokenBudget: 1000,
});
// A policy without a Team ceiling (a run snapshot from before maxAccessLevel): capped by the supervisor.
const outside = { ...policy, maxAccessLevel: undefined };
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
  const read = buildSpawnedAgent(outside, supervisor, { provider: "codex" });
  assert.equal(read.accessLevel, "read");
  assert.equal(read.codexSandbox, "read-only");
  const write = buildSpawnedAgent(outside, supervisor, { provider: "gemini", accessLevel: "write" });
  assert.equal(write.agyMode, "accept-edits");
  assert.throws(() => buildSpawnedAgent(outside, supervisor, { provider: "codex", accessLevel: "full" }), /quyền của điều phối viên/);
  assert.throws(
    () => buildSpawnedAgent(outside, { ...supervisor, accessLevel: "read" }, { provider: "claude", accessLevel: "write" }),
    /quyền của điều phối viên/
  );
});

test("claude child tools stay inside the supervisor's allowlist and never include Task", () => {
  const omitted = buildSpawnedAgent(outside, supervisor, { provider: "claude" });
  assert.deepEqual(omitted.allowedTools, ["Read", "Grep"], "Task is dropped from the ceiling, and a read child gets no write tool");
  assert.deepEqual(omitted.disallowedTools, KNOWN_TOOLS.filter((t) => !["Read", "Grep"].includes(t)));
  assert.deepEqual(buildSpawnedAgent(outside, supervisor, { provider: "claude", accessLevel: "write" }).allowedTools, ["Read", "Grep", "Edit"]);
  assert.equal(omitted.permissionMode, "default", "level read by default (write tools are blocked at spawn time)");

  assert.throws(() => buildSpawnedAgent(outside, supervisor, { provider: "claude", tools: ["Bash"] }), /vượt quá quyền/);
  assert.throws(() => buildSpawnedAgent(outside, supervisor, { provider: "claude", tools: ["Task"] }), /Task/);

  const none = buildSpawnedAgent(outside, supervisor, { provider: "claude", tools: [] });
  assert.deepEqual(none.disallowedTools, KNOWN_TOOLS, "no tools chosen = every tool denied, not unrestricted");

  // a codex/agy supervisor has no Claude allowlist: its level decides
  const codexSup = { provider: "codex", accessLevel: "read" };
  assert.deepEqual(buildSpawnedAgent(outside, codexSup, { provider: "claude" }).allowedTools, ["Read", "Grep", "Glob", "WebFetch", "WebSearch"]);
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

test("blueprints: normalized leniently, defaults to read, keeps provider order and per-provider instructions", () => {
  const [b] = normalizeBlueprints([
    { name: " Painter ", role: "Images", accessLevel: "root", providers: [{ provider: "gemini", instructions: "PNG" }, { provider: "claude", model: "sonnet" }, { provider: "" }], tools: ["Read", "Nope"] },
  ]);
  assert.equal(b.name, "painter");
  assert.equal(b.accessLevel, "read");
  assert.deepEqual(b.providers, [
    { provider: "gemini", model: "", instructions: "PNG" },
    { provider: "claude", model: "sonnet", instructions: "" },
  ]);
  assert.deepEqual(b.tools, ["Read"]);
  assert.equal(normalizeBlueprints([{ name: "x", providers: [] }])[0].tools, null, "no list = everything the ceiling allows");
  assert.deepEqual(normalizeBlueprints(undefined), []);
});

test("buildBlueprintAgent: capped by the supervisor, never the Task tool", () => {
  const sup = { provider: "claude", accessLevel: "write", allowedTools: ["Read", "Edit"] };
  const bp = normalizeBlueprints([{ name: "dev", accessLevel: "write", instructions: "Base", providers: [{ provider: "claude", instructions: "Extra" }] }])[0];
  const agent = buildBlueprintAgent(sup, bp, bp.providers[0], 0);
  assert.equal(agent.appendSystemPrompt, "Base\n\nExtra");
  assert.deepEqual(agent.allowedTools, ["Read", "Edit"]);
  assert.ok(agent.disallowedTools.includes("Bash"));
  assert.throws(() => buildBlueprintAgent(sup, { ...bp, tools: ["Bash"] }, bp.providers[0], 0), /vượt quá quyền/);
  assert.throws(() => buildBlueprintAgent(sup, { ...bp, tools: ["Task"] }, bp.providers[0], 0), /Task/);
  assert.throws(() => buildBlueprintAgent({ ...sup, accessLevel: "read" }, bp, bp.providers[0], 0), /vượt quá quyền tối đa/);
});

test("spawnCeiling: a Team's maxAccessLevel caps spawns; without it the supervisor does", () => {
  const readCoord = { provider: "claude", accessLevel: "read", allowedTools: ["Read", "Grep", "Glob"] };
  assert.equal(normalizeSpawnPolicy({}).maxAccessLevel, "read", "default read");
  assert.equal(normalizeSpawnPolicy({ maxAccessLevel: "root" }).maxAccessLevel, "read");

  const same = spawnCeiling(normalizeSpawnPolicy({}), readCoord);
  assert.deepEqual(same, { level: "read", tools: ["Read", "Grep", "Glob"], source: "team" }, "teams saved before: exactly the coordinator's tools, as before");

  const raised = spawnCeiling(normalizeSpawnPolicy({ maxAccessLevel: "write" }), readCoord);
  assert.equal(raised.level, "write");
  assert.ok(raised.tools.includes("Edit") && raised.tools.includes("Write") && !raised.tools.includes("Task"));

  const capped = spawnCeiling(normalizeSpawnPolicy({}), { provider: "claude", accessLevel: "write", allowedTools: ["Read", "Edit"] });
  assert.deepEqual(capped, { level: "read", tools: ["Read"], source: "team" }, "a read ceiling never has write tools");

  assert.equal(spawnCeiling({ enabled: true }, readCoord).source, "supervisor", "no Team ceiling: the supervisor's own");

  const policyW = normalizeSpawnPolicy({ enabled: true, providers: ["claude"], maxAccessLevel: "write" });
  assert.equal(buildSpawnedAgent(policyW, readCoord, { provider: "claude", accessLevel: "write" }).permissionMode, "acceptEdits");
  assert.throws(() => buildSpawnedAgent({ ...policyW, maxAccessLevel: "read" }, readCoord, { provider: "claude", accessLevel: "write" }), /mà Team cho phép/);
  assert.throws(() => buildSpawnedAgent(policyW, readCoord, { provider: "claude", accessLevel: "full" }), /vượt quá quyền tối đa "write"/);
});

test("inline blueprint: the coordinator defines the agent, inside the policy's providers and models", () => {
  const b = buildInlineBlueprint(policy, { name: "Backend Dev", role: "Builds the API", instructions: "You write Node.", provider: "claude", model: "sonnet", accessLevel: "write" });
  assert.equal(b.name, "backend-dev");
  assert.equal(b.inline, true);
  assert.deepEqual(b.providers, [{ provider: "claude", model: "sonnet", instructions: "" }]);
  assert.equal(b.tools, null);
  assert.throws(() => buildInlineBlueprint(policy, { name: "x", provider: "other" }), /không nằm trong danh sách/);
  assert.throws(() => buildInlineBlueprint(policy, { name: "x", provider: "claude", model: "opus" }), /không được phép/);
  assert.throws(() => buildInlineBlueprint(policy, { name: "", provider: "claude" }), /Cần name/);
  assert.throws(() => buildInlineBlueprint(policy, { name: "x", provider: "claude", accessLevel: "root" }), /không hợp lệ/);
  assert.throws(() => buildInlineBlueprint(policy, { name: "painter", provider: "claude" }, ["painter"]), /tên một blueprint/);
});

test("inline blueprint: access and tools are capped like a stored blueprint's", () => {
  const readOnly = { ...policy, maxAccessLevel: "read" };
  const tooHigh = buildInlineBlueprint(readOnly, { name: "dev", provider: "claude", accessLevel: "write" });
  assert.throws(() => buildBlueprintAgent({ ...supervisor, spawnPolicy: readOnly }, tooHigh, tooHigh.providers[0], 0), /vượt quá quyền tối đa/);
  const withTask = buildInlineBlueprint(policy, { name: "dev", provider: "claude", tools: ["Read", "Task"] });
  assert.throws(() => buildBlueprintAgent({ ...supervisor, spawnPolicy: policy }, withTask, withTask.providers[0], 0), /Task/);
});

test("opencode: no model = the connection's default; a named one must be on the list", () => {
  const withOpenCode = normalizeSpawnPolicy({ ...policy, providers: ["opencode"], opencodeModels: ["qwen/qwen3-coder:free"] });
  assert.deepEqual(withOpenCode.opencodeModels, ["qwen/qwen3-coder:free"]);
  assert.equal(buildSpawnedAgent(withOpenCode, supervisor, {}).model, "", "left to the connection's default model");
  assert.equal(buildSpawnedAgent(withOpenCode, supervisor, { model: "qwen/qwen3-coder:free" }).model, "qwen/qwen3-coder:free");
  assert.throws(() => buildSpawnedAgent(withOpenCode, supervisor, { provider: "opencode", model: "openai/gpt-5" }), /không được phép/);
  // A team that allows opencode but lists no model can still spawn it, on the default model.
  const noModels = { ...withOpenCode, opencodeModels: [] };
  assert.equal(buildInlineBlueprint(noModels, { name: "dev", provider: "opencode" }).providers[0].model, "");
});
