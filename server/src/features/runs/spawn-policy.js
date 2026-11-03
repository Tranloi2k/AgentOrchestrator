/**
 * Rules for the `spawn_agent` bridge tool, kept free of I/O so they can be unit-tested.
 *
 * Who may spawn, and from which providers/models, is declared on a Team workflow only (its
 * `spawnPolicy`, applied to the coordinator). What a spawned agent may *do* is capped by a
 * ceiling (spawnCeiling):
 *  - inside a Team, the Team's own `spawnPolicy.maxAccessLevel` (default read), so a read-only
 *    coordinator can spawn writers only when the Team owner allowed it explicitly;
 *  - otherwise (a policy without that field, e.g. a run snapshot from before it existed), the
 *    supervisor's own level and tools, as it always was.
 * A spawned agent never gets the Claude sub-agent tool (`Task`), so it can't fan out on its own.
 * executor.js spawnAgent and team-calls.js spawnBlueprint do the actual spawning.
 */
import { PROVIDERS, KNOWN_TOOLS, SUBAGENT_TOOL } from "../../core/config.js";
import { ACCESS_LEVELS, WRITE_TOOLS, levelRank, settingsForLevel, toolCeiling } from "../agents/access.js";

/**
 * The most a spawned agent may get: { level, tools, source }. A Team's maxAccessLevel sets the
 * level. Its tools are the supervisor's own (as before) unless the Team allows a level above the
 * supervisor's; then every known tool is available up to that level, since the supervisor's
 * allowlist only says what the supervisor itself may do. A read ceiling never has write tools.
 * Without a Team ceiling (`source: "supervisor"`) both come from the supervisor.
 */
export function spawnCeiling(policy, supervisor) {
  const own = supervisor?.accessLevel || "read";
  const ownTools = toolCeiling(supervisor || {});
  if (!ACCESS_LEVELS.includes(policy?.maxAccessLevel)) return { level: own, tools: ownTools, source: "supervisor" };
  const level = policy.maxAccessLevel;
  const tools = levelRank(level) > levelRank(own) ? KNOWN_TOOLS.filter((t) => t !== SUBAGENT_TOOL) : ownTools;
  return { level, tools: toolsAtLevel(tools, level), source: "team" };
}

/** The ceiling's tools a child at `level` gets when none are named: no write tools for a reader. */
function toolsAtLevel(tools, level) {
  return tools.filter((t) => level !== "read" || !WRITE_TOOLS.includes(t));
}

/** Why a level is refused, worded after where the ceiling comes from. */
function levelError(what, level, ceiling) {
  return ceiling.source === "team"
    ? `${what} cần quyền "${level}", vượt quá quyền tối đa "${ceiling.level}" mà Team cho phép cấp cho agent con (spawnPolicy.maxAccessLevel).`
    : `${what} cần quyền "${level}", vượt quá quyền tối đa "${ceiling.level}" (quyền của điều phối viên).`;
}

// New tokens processed: input + output + cache writes. Cache reads are left out — they re-read the same
// context on every turn, so counting them would exhaust any budget after one real agent.
export const spawnedTokens = (run) =>
  run.tasks
    .filter((t) => t.kind === "agent-spawn")
    .reduce((sum, t) => sum + (t.usage?.inputTokens || 0) + (t.usage?.outputTokens || 0) + (t.usage?.cacheCreationTokens || 0), 0);

/** What one spawned agent counts as against maxAgents: its blueprint work item, or the task itself. */
const spawnKey = (t) => (t.spawn?.blueprint && t.workItemId ? `${t.spawn.blueprint}|${t.workItemId}` : t.id ?? t);

/**
 * Spawned agents so far, as maxAgents counts them: a blueprint's work item counts once however many
 * fix rounds, provider switches or replays it has; an ad-hoc spawn counts once per call.
 */
export const spawnedCount = (run) => new Set(run.tasks.filter((t) => t.kind === "agent-spawn").map(spawnKey)).size;

/** The key a blueprint spawn of `workItemId` counts under (see spawnedCount). */
export const blueprintSpawnKey = (blueprint, workItemId) => `${blueprint}|${workItemId}`;

/**
 * Checks a spawn request against the team's spawnPolicy and the supervisor's own ceiling, and
 * turns it into a throwaway agent config. The result is never saved and has no skills, plugins
 * or spawn rights of its own. For Claude, every known tool outside the chosen set is explicitly
 * denied, not just left out — an empty allow list would otherwise mean "no restriction".
 *
 * `accessLevel` defaults to "read": a child only gets to edit when the supervisor asks for it.
 */
export function buildSpawnedAgent(policy, supervisor, { provider, model, tools, accessLevel }) {
  if (!provider) {
    if (policy.providers.length !== 1) throw new Error(`Cần chọn provider: ${policy.providers.join(", ") || "(không có provider nào được phép)"}.`);
    provider = policy.providers[0];
  }
  if (!policy.providers.includes(provider)) throw new Error(`Provider "${provider}" không nằm trong danh sách cho phép: ${policy.providers.join(", ") || "(trống)"}.`);

  model = String(model || "");
  const allowedModels = { codex: policy.codexModels, gemini: policy.geminiModels }[provider] || policy.claudeModels;
  if (model && !allowedModels.includes(model)) {
    throw new Error(`Model "${model}" không được phép cho ${provider}. Được phép: mặc định của CLI${allowedModels.length ? ", " + allowedModels.join(", ") : ""}.`);
  }

  const ceiling = spawnCeiling(policy, supervisor);
  const level = accessLevel || "read";
  if (!ACCESS_LEVELS.includes(level)) throw new Error(`accessLevel "${level}" không hợp lệ. Dùng: ${ACCESS_LEVELS.join(", ")}.`);
  if (levelRank(level) > levelRank(ceiling.level)) throw new Error(levelError("Agent con", level, ceiling));
  const access = settingsForLevel(level);

  if (provider !== "claude") {
    return { provider, model, ...access, spawn: { provider, model, accessLevel: level } };
  }

  const chosen = tools === undefined ? toolsAtLevel(ceiling.tools, level) : [...new Set((tools || []).map(String))];
  if (chosen.includes(SUBAGENT_TOOL)) throw new Error("Agent con không bao giờ được dùng tool Task (tự chia việc nội bộ).");
  const denied = chosen.filter((t) => !ceiling.tools.includes(t));
  if (denied.length) throw new Error(`Tool vượt quá quyền được cấp cho agent con: ${denied.join(", ")}. Được phép: ${ceiling.tools.join(", ") || "(không có)"}.`);
  return {
    provider: "claude",
    model,
    ...access,
    allowedTools: chosen,
    disallowedTools: KNOWN_TOOLS.filter((t) => !chosen.includes(t)),
    spawn: { provider, model, accessLevel: level, tools: chosen },
  };
}

/** --------------------------- blueprints: roles a Team's coordinator may spawn --------------------------- */

export const MAX_BLUEPRINTS = 20;
export const MAX_BLUEPRINT_PROVIDERS = 6;
const BLUEPRINT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const isBlueprintName = (name) => BLUEPRINT_NAME_RE.test(name);

/**
 * A Team's blueprints as stored. Each is a role the coordinator may spawn by name:
 *  - name:         alias-style id, unique in the team
 *  - role:         one line, shown to the coordinator
 *  - instructions: the spawned agent's system prompt; skillIds are added to it like an agent's
 *  - accessLevel:  read / write / full
 *  - providers:    tried in order, each { provider, model, instructions }; `instructions` is
 *                  appended for that provider only (e.g. "draw an SVG instead" for Claude)
 *  - tools:        Claude tool allowlist, or null for everything the ceiling allows
 * Lenient like the rest of loading: unknown providers and skills are kept so validation can
 * report them; at run time an unknown provider is just skipped.
 */
export function normalizeBlueprints(input) {
  const str = (v, max) => String(v ?? "").slice(0, max);
  return (Array.isArray(input) ? input : [])
    .filter(Boolean)
    .slice(0, MAX_BLUEPRINTS)
    .map((b) => ({
      name: str(b.name, 40).trim().toLowerCase(),
      role: str(b.role, 300).trim(),
      instructions: str(b.instructions, 20000),
      skillIds: [...new Set((Array.isArray(b.skillIds) ? b.skillIds : []).map(String).filter(Boolean))].slice(0, 30),
      accessLevel: ACCESS_LEVELS.includes(b.accessLevel) ? b.accessLevel : "read",
      providers: (Array.isArray(b.providers) ? b.providers : [])
        .filter((p) => p && String(p.provider || "").trim())
        .slice(0, MAX_BLUEPRINT_PROVIDERS)
        .map((p) => ({ provider: str(p.provider, 20).trim().toLowerCase(), model: str(p.model, 100).trim(), instructions: str(p.instructions, 5000) })),
      tools: Array.isArray(b.tools) ? [...new Set(b.tools.map(String))].filter((t) => KNOWN_TOOLS.includes(t) || t === SUBAGENT_TOOL) : null,
    }));
}

/** The id a blueprint's provider entry runs under: stable, so a work item's rounds stay on it. */
export const blueprintAgentId = (blueprint, entry, index) => `blueprint:${blueprint.name}#${index}:${entry.provider}${entry.model ? `:${entry.model}` : ""}`;

/**
 * The throwaway agent one provider entry of a blueprint runs as. Its access is the blueprint's
 * level, capped like any spawn by spawnCeiling (the Team's maxAccessLevel). The blueprint's
 * instructions plus the entry's own become its system prompt, and its skills come along.
 * Throws when the blueprint asks for more than may be handed out (validation refuses that on
 * save; this covers run snapshots and anything that bypasses it).
 */
export function buildBlueprintAgent(supervisor, blueprint, entry, index) {
  const ceiling = spawnCeiling(supervisor.spawnPolicy, supervisor);
  const level = blueprint.accessLevel || "read";
  if (levelRank(level) > levelRank(ceiling.level)) throw new Error(levelError(`Blueprint "${blueprint.name}"`, level, ceiling));
  const provider = entry.provider;
  const model = entry.model || "";
  const base = {
    id: blueprintAgentId(blueprint, entry, index),
    name: `${blueprint.name} · ${provider}${model ? ` · ${model}` : ""}`,
    provider,
    model,
    ...settingsForLevel(level),
    appendSystemPrompt: [blueprint.instructions, entry.instructions].map((s) => String(s || "").trim()).filter(Boolean).join("\n\n"),
    skillIds: blueprint.skillIds || [],
  };
  const spawn = { blueprint: blueprint.name, provider, model, accessLevel: level };
  if (provider !== "claude") return { ...base, spawn };

  const chosen = blueprint.tools == null ? toolsAtLevel(ceiling.tools, level) : [...new Set(blueprint.tools)];
  if (chosen.includes(SUBAGENT_TOOL)) throw new Error(`Blueprint "${blueprint.name}": agent con không bao giờ được dùng tool Task.`);
  const denied = chosen.filter((t) => !ceiling.tools.includes(t));
  if (denied.length) throw new Error(`Blueprint "${blueprint.name}" có tool vượt quá quyền được cấp: ${denied.join(", ")}. Được phép: ${ceiling.tools.join(", ") || "(không có)"}.`);
  return {
    ...base,
    allowedTools: chosen,
    disallowedTools: KNOWN_TOOLS.filter((t) => !chosen.includes(t)),
    spawn: { ...spawn, tools: chosen },
  };
}

/**
 * Throws when the run can't take another spawned agent. maxAgents counts every spawn so far,
 * including ones still running, so parallel calls can't overshoot it. tokenBudget only sees
 * spawns that have finished, because the CLIs report usage when they exit — so it is a check
 * before each spawn, and agents already running can still push the total past it.
 */
export function checkSpawnLimits(run, policy, { key = null } = {}) {
  // Another round of a work item that already has its agent is not a new agent.
  const known = key && run.tasks.some((t) => t.kind === "agent-spawn" && spawnKey(t) === key);
  if (!known && spawnedCount(run) >= policy.maxAgents) {
    throw new Error(`Đã tạo đủ ${policy.maxAgents} agent cho run này — không tạo thêm được. Hãy tự làm phần việc còn lại.`);
  }
  const used = spawnedTokens(run);
  if (policy.tokenBudget && used >= policy.tokenBudget) {
    throw new Error(`Đã dùng hết ngân sách token cho agent con (${used}/${policy.tokenBudget}).`);
  }
}

/**
 * A Team's spawn_agent setting: which providers/models its coordinator may create agents with,
 * and how many / how many tokens per run. A provider's CLI-default model ("") is always allowed.
 *  - maxAgents:   spawned agents per run
 *  - tokenBudget: tokens (input + output + cache writes) spawned agents may use per run; 0 = no limit
 */
export function normalizeSpawnPolicy(input) {
  const strings = (v) => [...new Set((Array.isArray(v) ? v : []).map((s) => String(s).slice(0, 100)).filter(Boolean))].slice(0, 30);
  const int = (v, fallback, min, max) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  return {
    enabled: !!input?.enabled,
    providers: strings(input?.providers).filter((p) => PROVIDERS.includes(p)),
    claudeModels: strings(input?.claudeModels),
    codexModels: strings(input?.codexModels),
    geminiModels: strings(input?.geminiModels),
    maxAgents: int(input?.maxAgents, 5, 1, 50),
    tokenBudget: int(input?.tokenBudget, 500000, 0, 100_000_000),
    // The most access a spawned agent may get in this Team (see spawnCeiling); read unless the
    // owner raises it.
    maxAccessLevel: ACCESS_LEVELS.includes(input?.maxAccessLevel) ? input.maxAccessLevel : "read",
  };
}
