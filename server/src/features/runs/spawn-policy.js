/**
 * Rules for the `spawn_agent` bridge tool, kept free of I/O so they can be unit-tested.
 *
 * Who may spawn, and from which providers/models, is declared on a Team workflow only (its
 * `spawnPolicy`, applied to the coordinator). What a spawned agent may *do* is never declared
 * here: it's capped by its supervisor — the coordinator's own agent — so a workflow can't hand a
 * child more than the supervisor has itself:
 *  - access level ≤ the supervisor's level (see access.js),
 *  - Claude tools ⊆ the supervisor's tool ceiling,
 *  - never the Claude sub-agent tool (`Task`), so a child can't fan out further on its own.
 * executor.js spawnAgent does the actual spawning.
 */
import { PROVIDERS, KNOWN_TOOLS, SUBAGENT_TOOL } from "../../core/config.js";
import { ACCESS_LEVELS, levelRank, settingsForLevel, toolCeiling } from "../agents/access.js";

// New tokens processed: input + output + cache writes. Cache reads are left out — they re-read the same
// context on every turn, so counting them would exhaust any budget after one real agent.
export const spawnedTokens = (run) =>
  run.tasks
    .filter((t) => t.kind === "agent-spawn")
    .reduce((sum, t) => sum + (t.usage?.inputTokens || 0) + (t.usage?.outputTokens || 0) + (t.usage?.cacheCreationTokens || 0), 0);

export const spawnedCount = (run) => run.tasks.filter((t) => t.kind === "agent-spawn").length;

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

  const maxLevel = supervisor.accessLevel || "read";
  const level = accessLevel || "read";
  if (!ACCESS_LEVELS.includes(level)) throw new Error(`accessLevel "${level}" không hợp lệ. Dùng: ${ACCESS_LEVELS.join(", ")}.`);
  if (levelRank(level) > levelRank(maxLevel)) {
    throw new Error(`Agent con không được có quyền cao hơn điều phối viên: yêu cầu "${level}", tối đa "${maxLevel}".`);
  }
  const access = settingsForLevel(level);

  if (provider !== "claude") {
    return { provider, model, ...access, spawn: { provider, model, accessLevel: level } };
  }

  const ceiling = toolCeiling(supervisor);
  const chosen = tools === undefined ? ceiling.slice() : [...new Set((tools || []).map(String))];
  if (chosen.includes(SUBAGENT_TOOL)) throw new Error("Agent con không bao giờ được dùng tool Task (tự chia việc nội bộ).");
  const denied = chosen.filter((t) => !ceiling.includes(t));
  if (denied.length) throw new Error(`Tool vượt quá quyền của điều phối viên: ${denied.join(", ")}. Được phép: ${ceiling.join(", ") || "(không có)"}.`);
  return {
    provider: "claude",
    model,
    ...access,
    allowedTools: chosen,
    disallowedTools: KNOWN_TOOLS.filter((t) => !chosen.includes(t)),
    spawn: { provider, model, accessLevel: level, tools: chosen },
  };
}

/**
 * Throws when the run can't take another spawned agent. maxAgents counts every spawn so far,
 * including ones still running, so parallel calls can't overshoot it. tokenBudget only sees
 * spawns that have finished, because the CLIs report usage when they exit — so it is a check
 * before each spawn, and agents already running can still push the total past it.
 */
export function checkSpawnLimits(run, policy) {
  if (spawnedCount(run) >= policy.maxAgents) {
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
  };
}
