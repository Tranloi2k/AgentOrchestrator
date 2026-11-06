/**
 * What an `opencode run` process is told, pure so it can be tested: the inline config passed in
 * OPENCODE_CONFIG_CONTENT (permissions from the agent's access level, the OpenRouter key, the
 * system prompt file, the agent-bridge MCP server), the model id, and the usage it reports.
 *
 * The key itself is never written into the config or argv: the config says
 * `{env:AO_OPENROUTER_API_KEY}` and the key travels in that variable of the child's environment.
 */

export const OPENROUTER_KEY_ENV = "AO_OPENROUTER_API_KEY";

// Asking needs a person at a terminal; a headless run has none, so nothing here is "ask".
// `question` (the model asking the user) and `doom_loop` (the same call over and over) have no one
// to answer them either. Reading .env files stays off below full access, as in OpenCode's defaults.
const NO_ENV_FILES = { "*": "allow", "*.env": "deny", "*.env.*": "deny" };
const PERMISSIONS = {
  read: { read: NO_ENV_FILES, edit: "deny", bash: "deny", external_directory: "deny", question: "deny", doom_loop: "deny" },
  write: { read: NO_ENV_FILES, edit: "allow", bash: "allow", external_directory: "deny", question: "deny", doom_loop: "deny" },
  full: { "*": "allow", question: "deny", doom_loop: "deny" },
};

export function opencodePermission(accessLevel) {
  return PERMISSIONS[accessLevel] || PERMISSIONS.read;
}

/**
 * OpenRouter model id → OpenCode's `provider/model`: `qwen/qwen3-coder:free` →
 * `openrouter/qwen/qwen3-coder:free`. Always prefixed: OpenRouter's own routers are named
 * `openrouter/auto` and `openrouter/free`, so a leading "openrouter/" is part of the id.
 */
export function opencodeModelId(model) {
  const m = String(model || "").trim();
  return m ? `openrouter/${m}` : "";
}

/**
 * The inline config for one run. `bridge` is { script, env, timeoutMs } when the agent is wired
 * to the agent-bridge MCP server (ask_agent / spawn_agent / complete_work_item), else null.
 */
export function buildOpenCodeConfig({ accessLevel, instructionsFile = null, bridge = null }) {
  const config = {
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    provider: { openrouter: { options: { apiKey: `{env:${OPENROUTER_KEY_ENV}}` } } },
    permission: opencodePermission(accessLevel),
  };
  // Forward slashes: the path goes through OpenCode's own glob handling.
  if (instructionsFile) config.instructions = [instructionsFile.replace(/\\/g, "/")];
  if (bridge) {
    config.mcp = {
      "agent-bridge": {
        type: "local",
        command: ["node", bridge.script],
        environment: bridge.env,
        enabled: true,
        ...(bridge.timeoutMs ? { timeout: bridge.timeoutMs } : {}),
      },
    };
  }
  return config;
}

/** Adds one `step_finish` event's tokens/cost to the running total (null = nothing yet). */
export function addOpenCodeUsage(total, evt, wallDurationMs) {
  const tokens = evt?.part?.tokens;
  if (!tokens) return total;
  const cost = Number(evt.part.cost);
  const prev = total || { provider: "opencode", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null, durationMs: 0 };
  return {
    ...prev,
    inputTokens: prev.inputTokens + (Number(tokens.input) || 0),
    outputTokens: prev.outputTokens + (Number(tokens.output) || 0) + (Number(tokens.reasoning) || 0),
    cacheReadTokens: prev.cacheReadTokens + (Number(tokens.cache?.read) || 0),
    cacheCreationTokens: prev.cacheCreationTokens + (Number(tokens.cache?.write) || 0),
    costUsd: Number.isFinite(cost) ? (prev.costUsd || 0) + cost : prev.costUsd,
    durationMs: wallDurationMs,
  };
}
