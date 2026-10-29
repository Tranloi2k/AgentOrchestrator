/**
 * Agent access, declared in exactly one place: the agent's `accessLevel` ("what this agent may
 * do on its own"). Everything provider-specific is derived from it, and the per-provider fields
 * an agent can still set (its "advanced" settings) may only lower it, never raise it. Workflows
 * decide who an agent may hand work to or spawn, and never exceed this ceiling — see
 * spawn-policy.js for how a spawned agent is capped by its supervisor.
 *
 * Claude's read-only is not plan mode: plan mode also blocks MCP tools, so a read-only
 * coordinator couldn't hand out work through ask_agent. It runs in "default" mode instead, with
 * every tool that can change something (claudeToolAccess) denied outright. plan stays available
 * as a lower setting.
 *
 *   level   | claude permissionMode | codex sandbox      | agy (Gemini CLI) mode
 *   read    | default + write tools | read-only          | plan
 *           | blocked (see below)   |                    |
 *   write   | acceptEdits           | workspace-write    | accept-edits
 *   full    | bypassPermissions     | danger-full-access | skip (--dangerously-skip-permissions)
 */
import { KNOWN_TOOLS, SUBAGENT_TOOL } from "../../core/config.js";

export const ACCESS_LEVELS = ["read", "write", "full"];

// Least to most permissive. Each level may use its own default and anything before it.
export const CLAUDE_PERMISSION_MODES = ["plan", "default", "acceptEdits", "auto", "bypassPermissions"];
export const CODEX_SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];
// agy has no true read-only mode: in a headless run it lets file edits in the workspace through
// and auto-denies shell commands, whatever --mode says, except that "plan" makes it plan instead
// of edit (so it changes nothing) and "skip" (--dangerously-skip-permissions) allows everything.
// "auto" is left out: it behaved exactly like accept-edits headless.
export const AGY_MODES = ["plan", "accept-edits", "skip"];

const LEVEL_DEFAULTS = {
  read: { permissionMode: "default", codexSandbox: "read-only", agyMode: "plan" },
  write: { permissionMode: "acceptEdits", codexSandbox: "workspace-write", agyMode: "accept-edits" },
  full: { permissionMode: "bypassPermissions", codexSandbox: "danger-full-access", agyMode: "skip" },
};

/** Tools that only read, used as the tool ceiling of a read-only agent that has no Claude allowlist. */
const READ_TOOLS = ["Read", "Grep", "Glob", "WebFetch", "WebSearch"];

/** Claude tools that can change files or run anything; never available to a read-only agent. */
const WRITE_TOOLS = ["Edit", "Write", "NotebookEdit", "Bash"];

// Bumped when the meaning of stored access settings changes; older agents are migrated on load.
const ACCESS_VERSION = 2;

const rank = (list, value) => list.indexOf(value);
export const levelRank = (level) => rank(ACCESS_LEVELS, level);

/** Values of `list` a given level may use: its own default and anything less permissive. */
export function modesForLevel(list, field, level) {
  const max = rank(list, LEVEL_DEFAULTS[level][field]);
  return list.slice(0, max + 1);
}

/** `value` if this level allows it, otherwise the level's default. */
function capped(list, field, level, value) {
  return modesForLevel(list, field, level).includes(value) ? value : LEVEL_DEFAULTS[level][field];
}

/**
 * Level for an agent saved before `accessLevel` existed, read off whatever its own provider used
 * (legacy fields included: readOnly, and the old Gemini CLI approval modes).
 */
function legacyLevel(input) {
  if (input.readOnly) return "read";
  if (input.provider === "codex") {
    return { "read-only": "read", "danger-full-access": "full" }[input.codexSandbox] || "write";
  }
  if (input.provider === "gemini") {
    const mode = input.agyMode || input.geminiApprovalMode;
    if (["plan", "default"].includes(mode)) return "read";
    if (["yolo", "skip"].includes(mode)) return "full";
    return "write";
  }
  if (input.permissionMode === "plan") return "read";
  // "auto" approves more than acceptEdits, so it only fits under "full" (kept there as a lowered mode).
  if (["auto", "bypassPermissions"].includes(input.permissionMode)) return "full";
  return "write";
}

/** Agent access fields as stored: the level, plus provider settings capped at it. */
export function normalizeAccess(input) {
  const level = ACCESS_LEVELS.includes(input.accessLevel) ? input.accessLevel : legacyLevel(input);
  const codexSandbox = capped(CODEX_SANDBOX_MODES, "codexSandbox", level, input.codexSandbox);
  // Before v2 a read-only Claude agent was stored as plan mode; that was the level's default then,
  // not a choice, so it moves to the new default (which can still hand out work).
  const legacyPlan = (input.accessVersion || 1) < 2 && level === "read" && input.permissionMode === "plan";
  return {
    accessVersion: ACCESS_VERSION,
    accessLevel: level,
    permissionMode: legacyPlan ? LEVEL_DEFAULTS.read.permissionMode : capped(CLAUDE_PERMISSION_MODES, "permissionMode", level, input.permissionMode),
    codexSandbox,
    // Outbound network from inside workspace-write is more than "edit the workspace", so it's
    // only available to a full-access agent that chose to run in the narrower sandbox.
    codexNetworkAccess: level === "full" && codexSandbox === "workspace-write" && !!input.codexNetworkAccess,
    agyMode: capped(AGY_MODES, "agyMode", level, legacyAgyMode(input)),
  };
}

function legacyAgyMode(input) {
  if (input.agyMode) return input.agyMode;
  return { plan: "plan", default: "plan", auto_edit: "accept-edits", yolo: "skip" }[input.geminiApprovalMode];
}

/** Provider settings for a throwaway agent at `level` (spawned agents get the level defaults). */
export function settingsForLevel(level) {
  return { accessLevel: level, ...LEVEL_DEFAULTS[level], codexNetworkAccess: false };
}

/**
 * The most tools an agent spawned by `agent` may get: the supervisor's own Claude allowlist, or —
 * for a codex/agy supervisor, which has no Claude tool list — what its access level implies.
 * The sub-agent tool is never included: a spawned agent can't fan out further on its own.
 */
export function toolCeiling(agent) {
  const tools = agent.provider === "claude" || !agent.provider
    ? agent.allowedTools || []
    : agent.accessLevel === "read"
      ? READ_TOOLS
      : KNOWN_TOOLS;
  return tools.filter((t) => t !== SUBAGENT_TOOL && KNOWN_TOOLS.includes(t));
}

/** For the agent form: per level, the provider settings it may pick (its default is the last one). */
export function accessOptions() {
  return Object.fromEntries(
    ACCESS_LEVELS.map((level) => [
      level,
      {
        permissionMode: modesForLevel(CLAUDE_PERMISSION_MODES, "permissionMode", level),
        codexSandbox: modesForLevel(CODEX_SANDBOX_MODES, "codexSandbox", level),
        agyMode: modesForLevel(AGY_MODES, "agyMode", level),
      },
    ])
  );
}

/**
 * The Claude tool flags an agent actually runs with: its allowlist, minus every write tool when
 * it's read-only, and everything else denied. Applied at spawn time, so it also covers spawned
 * agents and anything that bypasses the form.
 */
export function claudeToolAccess(agent) {
  const readOnly = agent?.accessLevel === "read";
  const allowed = (agent?.allowedTools || []).filter((t) => !(readOnly && WRITE_TOOLS.includes(t)));
  const denied = new Set(agent?.disallowedTools || []);
  if (readOnly) WRITE_TOOLS.forEach((t) => denied.add(t));
  for (const t of KNOWN_TOOLS) if (agent?.toolPolicy === "allowlist" && !allowed.includes(t)) denied.add(t);
  return { allowed, denied: [...denied].filter((t) => !allowed.includes(t)) };
}
