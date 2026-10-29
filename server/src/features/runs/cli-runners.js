/**
 * Provider CLI runners: builds the argv for `claude -p` / `codex exec`, wires in the
 * agent-bridge MCP server, spawns the process, streams its output into the task log and
 * resolves with the final text + usage. Also tracks every spawned process per run so a run can
 * be stopped. To add a provider, add a run<Provider>Process here and dispatch to it in
 * runAgentProcess.
 */
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir, homedir } from "node:os";
import { randomBytes } from "node:crypto";
import spawn from "cross-spawn";
import treeKill from "tree-kill";
import { classifyAgentFailure } from "./delegation-policy.js";
import { HOST, INTERNAL_TOKEN, isLoopbackHost } from "../../core/security.js";
import { BRIDGE_SCRIPT, MAX_CALL_DEPTH, KNOWN_TOOLS, SUBAGENT_TOOL, SUBAGENT_SYSTEM_PROMPT, PROVIDER_AVAILABILITY, AGY_BIN } from "../../core/config.js";
import { toolCeiling, claudeToolAccess } from "../agents/access.js";
import { getAgent } from "../agents/agents.store.js";
import { getSkill } from "../skills/skills.store.js";
import { getPlugin } from "../plugins/plugins.store.js";
import { nodeTitle } from "../workflows/node-title.js";
import { pushTaskLog, setClaudeQuota } from "./run-store.js";

/** --------------------------- stopping a run --------------------------- */

/** runId -> live ChildProcess objects spawned for that run. A run can have several at once
 * (parallel branches, plus any ask_agent callee running inside one of them). */
const liveChildren = new Map();

/** How long a bridge tool call (ask_agent / spawn_agent) may block: 6 hours. */
const BRIDGE_TOOL_TIMEOUT_SEC = 6 * 60 * 60;

/** taskId -> live ChildProcess objects of that one task, so a node's timeout kills only it. */
const liveTaskChildren = new Map();

function trackChild(runId, child, taskId = null) {
  if (!liveChildren.has(runId)) liveChildren.set(runId, new Set());
  const set = liveChildren.get(runId);
  set.add(child);
  if (taskId) {
    if (!liveTaskChildren.has(taskId)) liveTaskChildren.set(taskId, new Set());
    liveTaskChildren.get(taskId).add(child);
  }
  const drop = () => {
    set.delete(child);
    if (!set.size) liveChildren.delete(runId);
    const own = taskId && liveTaskChildren.get(taskId);
    if (own) {
      own.delete(child);
      if (!own.size) liveTaskChildren.delete(taskId);
    }
  };
  child.on("close", drop);
  child.on("error", drop);
}

/**
 * Kills a spawned CLI *and everything it spawned*. This has to be a tree kill: `claude` and
 * `codex` are launched through their npm shim, and they in turn spawn the tools they run (and,
 * for a workflow node, our own mcp-bridge process). Killing just the pid we hold would orphan
 * that whole subtree, leaving agents happily editing files for a run the user already stopped.
 *
 * On POSIX we ask politely first (SIGTERM) and follow up with SIGKILL for anything still alive
 * after the grace period. On Windows tree-kill shells out to `taskkill /T /F`, which is always
 * forceful and ignores the signal argument — there's no graceful equivalent to offer there.
 */
function killTree(pid, { graceMs = 5000 } = {}) {
  if (!pid) return;
  treeKill(pid, "SIGTERM", () => {
    /* the callback's error is expected whenever the tree is already gone */
  });
  if (process.platform === "win32") return;
  setTimeout(() => treeKill(pid, "SIGKILL", () => { }), graceMs).unref();
}

/** Kills every process a run currently owns. No live child (e.g. stopped in the gap between two
 * nodes) is fine — the run's own loop notices the stop flag on its next iteration. */
function killRunProcesses(runId) {
  for (const child of [...(liveChildren.get(runId) || [])]) killTree(child.pid);
}

/** Combine agent's private instructions (its own appendSystemPrompt) with the content
 * of every shared skill it references, into one system-prompt string for `claude`. */
function buildSystemPrompt(agent) {
  const parts = [];
  if (agent?.appendSystemPrompt) parts.push(agent.appendSystemPrompt);
  for (const skillId of agent?.skillIds || []) {
    const skill = getSkill(skillId);
    if (skill?.content) parts.push(`## Skill: ${skill.name}\n${skill.content}`);
  }
  // Only on an explicit opt-in (the tool actually listed in allowedTools) — never when the list
  // is left empty/unrestricted, so existing agents don't silently change behaviour just because
  // the tool is technically reachable. Claude-only: codex and gemini have no equivalent tool.
  if ((agent?.provider || "claude") === "claude" && agent?.allowedTools?.includes(SUBAGENT_TOOL)) {
    parts.push(SUBAGENT_SYSTEM_PROMPT);
  }
  return parts.join("\n\n");
}

/**
 * One entry per live bridge process: sessionId -> who is calling (run, task, the agent config it
 * runs under, call depth, cwd). spawn_agent requests carry only the session id and the server
 * looks everything else up here, so an agent can't claim another agent's spawn policy or a
 * shallower depth by editing the request. Dropped when the CLI process exits.
 */
const bridgeSessions = new Map();

function getBridgeSession(sessionId) {
  return bridgeSessions.get(String(sessionId || "")) || null;
}

function closeBridgeSessionOnExit(child, bridgeEnv) {
  const sessionId = bridgeEnv?.AGENT_BRIDGE_SESSION;
  if (!sessionId) return;
  const close = () => bridgeSessions.delete(sessionId);
  child.on("close", close);
  child.on("error", close);
}

/**
 * Context for wiring the running agent up to `mcp-bridge.js`, the stdio MCP server that exposes
 * up to two tools:
 *  - `ask_agent`: call another node's agent in the same workflow synchronously. Only nodes in
 *    `node.calleeNodeIds` (configured in the workflow editor) are reachable.
 *  - `spawn_agent`: start a fresh, unsaved agent of a provider/model the coordinator of a Team
 *    picks, limited to the team's spawnPolicy and capped by the coordinator's own access
 *    (see spawn-policy.js). Only a team's coordinator node carries a spawnPolicy.
 *
 * Provider-neutral on purpose: `mcp-bridge.js` is a plain stdio MCP server with nothing
 * Claude-specific in it, so the same process serves both CLIs and only the flags that point at
 * it differ (buildClaudeBridgeArgs / buildCodexBridgeArgs below).
 *
 * Returns null when neither tool applies, or the call chain is already at MAX_CALL_DEPTH (so
 * agents calling/spawning agents can't recurse forever).
 */
function buildAgentBridgeContext(agent, node, workflow, { runId, taskId, cwd, depth }) {
  if (depth >= MAX_CALL_DEPTH) return null;
  const callable =
    node?.calleeNodeIds?.length && workflow
      ? node.calleeNodeIds
          .map((id) => workflow.nodes.find((n) => n.id === id))
          .filter(Boolean)
          // A team member is listed by alias (its id) with its role; other nodes by title and agent description.
          .map((n) => ({
            id: n.id,
            name: n.alias ? getAgent(n.agentId)?.name || n.agentId : nodeTitle(n),
            description: n.role || getAgent(n.agentId)?.description || "",
          }))
      : [];
  const spawnPolicy = agent?.spawnPolicy?.enabled ? agent.spawnPolicy : null;
  if (!callable.length && !spawnPolicy) return null;

  const sessionId = randomBytes(16).toString("hex");
  bridgeSessions.set(sessionId, { runId, taskId, agent, depth, cwd });

  return {
    AGENT_BRIDGE_URL: `http://${bridgeHost()}:${process.env.PORT || 5175}`,
    AGENT_BRIDGE_TOKEN: INTERNAL_TOKEN,
    AGENT_BRIDGE_SESSION: sessionId,
    AGENT_BRIDGE_RUN_ID: runId || "",
    AGENT_BRIDGE_TASK_ID: taskId || "",
    AGENT_BRIDGE_WORKFLOW_ID: workflow?.id || "",
    AGENT_BRIDGE_CALLER_NODE_ID: node?.id || "",
    AGENT_BRIDGE_DEPTH: String(depth),
    AGENT_BRIDGE_CWD: cwd || "",
    AGENT_BRIDGE_CALLABLE: JSON.stringify(callable),
    // Shown to the model in the tool description only; the server enforces the real policy,
    // including the ceiling this supervisor puts on what it spawns (its own level and tools).
    AGENT_BRIDGE_SPAWN_POLICY: spawnPolicy
      ? JSON.stringify({ ...spawnPolicy, maxAccessLevel: agent.accessLevel || "read", toolCeiling: toolCeiling(agent) })
      : "",
  };
}

/** MCP tool names (as Claude's --allowedTools spells them) that a bridge context exposes. */
function bridgeToolNames(env) {
  const names = [];
  if (env.AGENT_BRIDGE_CALLABLE !== "[]") names.push("mcp__agent-bridge__ask_agent");
  if (env.AGENT_BRIDGE_SPAWN_POLICY) names.push("mcp__agent-bridge__spawn_agent");
  return names;
}

/** Where the bridge should call back: the bound loopback address, or 127.0.0.1 when bound to
 * a wildcard/LAN address. Never "localhost" — it may resolve to ::1 while we listen on IPv4. */
function bridgeHost() {
  if (HOST === "::1") return "[::1]";
  return isLoopbackHost(HOST) && HOST !== "localhost" ? HOST : "127.0.0.1";
}

/** Claude Code takes the whole server definition as one inline JSON blob. */
function buildClaudeBridgeArgs(env) {
  return ["--mcp-config", JSON.stringify({ mcpServers: { "agent-bridge": { command: "node", args: [BRIDGE_SCRIPT], env } } })];
}

/**
 * Codex has no `--mcp-config`; it reads MCP servers from `~/.codex/config.toml` under
 * `[mcp_servers.<name>]`, and `-c key=value` overrides any of that per invocation with the
 * value parsed as TOML. So the same bridge is wired in as a set of dotted overrides — nothing
 * is written to the user's real config file.
 *
 * `default_tools_approval_mode = "approve"` is the load-bearing one. Without it `codex exec`
 * treats every MCP tool call as needing approval, and with no TTY to ask there's nobody to say
 * yes — the call comes back as `user cancelled MCP tool call` and the agent gives up. The valid
 * values are auto | prompt | writes | approve; "auto" is NOT enough (it still cancelled in
 * testing). This is scoped to the agent-bridge server only, so it grants nothing beyond
 * ask_agent — Codex's own shell/file tools stay governed by `-s/--sandbox` as before.
 */
function buildCodexBridgeArgs(env) {
  const s = (v) => JSON.stringify(String(v)); // TOML basic strings share JSON's escaping
  const envTable = Object.entries(env)
    .map(([k, v]) => `${k} = ${s(v)}`)
    .join(", ");
  return [
    "-c", `mcp_servers.agent-bridge.command=${s("node")}`,
    "-c", `mcp_servers.agent-bridge.args=[${s(BRIDGE_SCRIPT)}]`,
    "-c", `mcp_servers.agent-bridge.env={ ${envTable} }`,
    "-c", `mcp_servers.agent-bridge.default_tools_approval_mode=${s("approve")}`,
    // Codex gives up on an MCP tool call after 60s by default, but ask_agent / spawn_agent block
    // for as long as the other agent works.
    "-c", `mcp_servers.agent-bridge.tool_timeout_sec=${BRIDGE_TOOL_TIMEOUT_SEC}`,
  ];
}

/**
 * Same "cancelled, nobody's there to approve" problem as agent-bridge above, but for MCP
 * servers the user already has registered in their own `~/.codex/config.toml` (e.g. a
 * `codegraph` server) rather than one we wire in ourselves. `codex exec` has no TTY, so any
 * tool call on a server that isn't explicitly set to auto-approve comes back
 * "user cancelled MCP tool call" and the run stalls/fails on that step even though the process
 * itself keeps going. A per-tool override in the user's config (like
 * `[mcp_servers.codegraph.tools.codegraph_context]`) only covers the tools listed there — any
 * other tool on that same server (e.g. `codegraph_explore`) is still unapproved.
 *
 * We can't tell in advance which tools an agent will call, so instead of per-tool overrides we
 * set the server-level default for every *other* server already declared in config.toml —
 * agent-bridge is excluded since buildCodexBridgeArgs above already covers it, and this only
 * touches approval mode, nothing about sandboxing or what the server can actually do.
 */
function buildExternalMcpApprovalArgs() {
  let toml;
  try {
    toml = readFileSync(path.join(homedir(), ".codex", "config.toml"), "utf-8");
  } catch {
    return [];
  }
  const names = new Set();
  for (const m of toml.matchAll(/^\[mcp_servers\.([^.\]]+)\]\s*$/gm)) {
    if (m[1] && m[1] !== "agent-bridge") names.add(m[1]);
  }
  const s = (v) => JSON.stringify(String(v));
  const args = [];
  for (const name of names) {
    args.push("-c", `mcp_servers.${name}.default_tools_approval_mode=${s("approve")}`);
  }
  return args;
}

/** Resolve an agent's pluginIds into `--plugin-dir`/`--plugin-url` CLI args. */
function buildPluginArgs(agent) {
  const args = [];
  for (const pluginId of agent?.pluginIds || []) {
    const plugin = getPlugin(pluginId);
    if (!plugin) continue;
    if (plugin.sourceType === "url") {
      args.push("--plugin-url", plugin.sourceValue);
    } else if (plugin.localPath) {
      args.push("--plugin-dir", plugin.localPath);
    }
  }
  return args;
}

const RUNNERS = { claude: runClaudeProcess, codex: runCodexProcess, gemini: runAgyProcess };

/** Dispatches to the right local CLI based on the agent's `provider` — same {ok, resultText}
 * shape either way, so every call site (ad-hoc run, workflow node, ask_agent, spawn_agent) stays
 * provider-agnostic. `node`/`workflow`/`depth` (the agent bridge) apply to every provider;
 * only `extraArgs` is claude-specific. */
function runAgentProcess(opts) {
  const provider = RUNNERS[opts.agent?.provider] ? opts.agent.provider : "claude";
  // Defense in depth: the UI already refuses to let you pick an unavailable provider (see
  // PROVIDER_AVAILABILITY / /api/meta), but an agent saved before a CLI was uninstalled — or
  // reused from an export made on a different machine — could still reach here. Fail with a
  // clear message instead of a raw spawn ENOENT.
  if (!PROVIDER_AVAILABILITY[provider]) {
    const cmd = provider === "gemini" ? "agy" : provider;
    pushTaskLog(
      opts.runId,
      opts.taskId,
      `❌ CLI "${cmd}" không được cài đặt hoặc không có trong PATH của server. Cài đặt rồi khởi động lại server để dùng provider "${provider}".`
    );
    return Promise.resolve({ ok: false, resultText: "", usage: null, failureReason: "provider_unavailable" });
  }
  if (!opts.timeoutMs) return RUNNERS[provider](opts);

  // A per-attempt time limit (a workflow node's timeoutSec): kill this task's process tree when it
  // runs out, and report it as its own failure reason so retry logic can tell it apart.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    pushTaskLog(opts.runId, opts.taskId, `⏱️ Hết thời gian ${Math.round(opts.timeoutMs / 1000)}s — đang dừng agent.`);
    for (const child of [...(liveTaskChildren.get(opts.taskId) || [])]) killTree(child.pid);
  }, opts.timeoutMs);
  return RUNNERS[provider](opts).then((result) => {
    clearTimeout(timer);
    return timedOut ? { ...result, ok: false, failureReason: "timeout" } : result;
  });
}

/** Runs a single `claude -p` process, streams stdout(JSONL) as events, resolves final text. */
function runClaudeProcess({ runId, taskId, prompt, cwd, agent, node, workflow, extraArgs = [], depth = 0, resume = null }) {
  return new Promise((resolve) => {
    // --forward-subagent-text: when this agent uses Claude Code's own Task tool to spawn a
    // subagent, that subagent's text/thinking gets forwarded into this same stream-json output
    // (as assistant/user messages) instead of vanishing into the parent's summarized result —
    // so subagent activity actually shows up in this task's log below, not just its outcome.
    //
    // The prompt goes in on stdin and the system prompt through a file, never as argv: on Windows
    // `claude` is an npm .cmd shim, and a multi-line argument there is cut at its first line —
    // the agent got only "Yêu cầu gốc:" and nothing after it. Same bug codex had (see below).
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--forward-subagent-text",
      ...extraArgs,
    ];
    // Continuing a chat: pick the previous turn's session back up. Claude keeps sessions per
    // working directory, so the caller resumes in the same folder the session was started in.
    // --fork-session gives each chat turn its own session id, so deleting a turn can go back to the
    // session before it — the agent then really forgets the deleted turn.
    if (resume) args.push("--resume", resume, "--fork-session");
    if (agent?.model) args.push("--model", agent.model);
    if (agent?.permissionMode) args.push("--permission-mode", agent.permissionMode);

    const bridgeEnv = buildAgentBridgeContext(agent, node, workflow, { runId, taskId, cwd, depth });
    // The agent's allowlist, with write tools stripped when it's read-only (see claudeToolAccess).
    // An internal agent with no allowlist at all (the decompose planner) passes no flag; once the
    // bridge is wired in an explicit list is needed so its MCP tools are allowed too.
    const tools = claudeToolAccess(agent);
    let allowedTools = tools.allowed.length
      ? tools.allowed.slice()
      : bridgeEnv && agent?.toolPolicy !== "allowlist"
        ? KNOWN_TOOLS.filter((t) => !tools.denied.includes(t))
        : [];
    if (bridgeEnv) allowedTools.push(...bridgeToolNames(bridgeEnv));
    if (allowedTools.length) args.push("--allowedTools", allowedTools.join(" "));
    if (tools.denied.length) args.push("--disallowedTools", tools.denied.join(" "));
    if (bridgeEnv) args.push(...buildClaudeBridgeArgs(bridgeEnv));

    const systemPrompt = buildSystemPrompt(agent);
    let systemPromptFile = null;
    if (systemPrompt) {
      systemPromptFile = path.join(tmpdir(), `claude-system-${taskId}-${randomBytes(4).toString("hex")}.md`);
      writeFileSync(systemPromptFile, systemPrompt, "utf-8");
      args.push("--append-system-prompt-file", systemPromptFile);
    }
    args.push(...buildPluginArgs(agent));
    const cleanup = () => {
      if (!systemPromptFile) return;
      try {
        rmSync(systemPromptFile, { force: true });
      } catch {
        /* ignore */
      }
      systemPromptFile = null;
    };

    const child = spawn("claude", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    trackChild(runId, child, taskId);
    closeBridgeSessionOnExit(child, bridgeEnv);
    child.stdin.on("error", () => {
      /* claude already exited — its stderr is the useful error, not EPIPE */
    });
    child.stdin.end(prompt);
    let buffer = "";
    let resultText = "";
    let usage = null;
    let stderrText = "";
    let quotaSignal = false;
    let sessionId = null;
    const startedAt = Date.now();

    const pushLog = (line) => pushTaskLog(runId, taskId, line);

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.session_id) sessionId = evt.session_id;
          if (evt.type === "assistant" && evt.message?.content) {
            for (const block of evt.message.content) {
              if (block.type === "text" && block.text) {
                pushLog(`💬 ${block.text}`);
              } else if (block.type === "tool_use") {
                pushLog(`🔧 dùng tool: ${block.name} ${summarizeInput(block.input)}`);
              }
            }
          } else if (evt.type === "result") {
            resultText = evt.result || "";
            pushLog(`✅ Kết quả cuối:\n${resultText}`);
            // The final `result` event is the one place Claude reports what the whole turn
            // (all iterations, including any subagents) actually cost — token counts and
            // total_cost_usd aren't on the per-message `assistant` events above.
            usage = normalizeClaudeUsage(evt, Date.now() - startedAt);
          } else if (evt.type === "system") {
            pushLog(`ℹ️ ${evt.subtype || "system"}`);
          } else if (evt.type === "rate_limit_event" && evt.rate_limit_info) {
            const r = evt.rate_limit_info;
            setClaudeQuota(r);
            quotaSignal ||= Number(r.utilization) >= 1;
            pushLog(`ℹ️ Quota Claude (${r.rateLimitType}): đã dùng ${Math.round((r.utilization || 0) * 100)}%`);
          }
        } catch {
          pushLog(line);
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrText += text;
      pushLog(`⚠️ ${text.trim()}`);
    });

    child.on("error", (err) => {
      cleanup();
      pushLog(`❌ Lỗi khởi chạy claude CLI: ${err.message}`);
      resolve({
        ok: false,
        resultText: "",
        usage: null,
        failureReason: classifyAgentFailure({ spawnError: err, exitCode: 1, stderr: stderrText }),
      });
    });

    child.on("close", (code) => {
      cleanup();
      resolve({
        ok: code === 0,
        resultText,
        usage,
        sessionId,
        failureReason: classifyAgentFailure({ exitCode: code, stderr: stderrText, resultText, quotaSignal }),
      });
    });
  });
}

/** Normalizes the `usage`/`total_cost_usd` fields off Claude's final stream-json `result` event
 * into the same {provider, inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
 * costUsd, durationMs} shape runCodexProcess produces, so usage stats can be summed across
 * providers without every call site knowing the two CLIs' native field names. */
function normalizeClaudeUsage(evt, wallDurationMs) {
  const u = evt?.usage || {};
  return {
    provider: "claude",
    inputTokens: Number(u.input_tokens) || 0,
    outputTokens: Number(u.output_tokens) || 0,
    cacheReadTokens: Number(u.cache_read_input_tokens) || 0,
    cacheCreationTokens: Number(u.cache_creation_input_tokens) || 0,
    costUsd: typeof evt?.total_cost_usd === "number" ? evt.total_cost_usd : null,
    durationMs: typeof evt?.duration_ms === "number" ? evt.duration_ms : wallDurationMs,
  };
}

/**
 * Runs a single `codex exec --json` process — the OpenAI Codex CLI's non-interactive mode,
 * spawned the same way as `claude -p` (already-logged-in local CLI, no API key handled by
 * this app). Two differences worth knowing:
 *  - The event schema `--json` prints to stdout is not something we hard-parse here (unlike
 *    Claude's stream-json), since it isn't documented in `codex exec --help` and may shift
 *    between CLI versions — we best-effort pretty-print recognizable text fields for the live
 *    log and fall back to the raw JSON line otherwise, so nothing is silently dropped.
 *  - The one thing we *do* rely on being stable is `--output-last-message <file>`, which Codex
 *    writes the agent's final answer to regardless of the JSONL shape — that's what becomes
 *    `resultText` (what the rest of the app treats as "this step's output").
 * The two-way `ask_agent` bridge works here too, via `-c mcp_servers.*` overrides — see
 * buildCodexBridgeArgs. Still not available: per-tool allow/deny for Codex's OWN tools. Its
 * `[tools]` config table only has a handful of named toggles (web_search and friends), with no
 * generic enabled/disabled list, so a codex node's access to the shell and filesystem is
 * governed by `codexSandbox` alone. Skills/private system-prompt apply as before: prepended to
 * the prompt text itself, since codex has no `--append-system-prompt` flag.
 */
function runCodexProcess({ runId, taskId, prompt, cwd, agent, node, workflow, depth = 0 }) {
  return new Promise((resolve) => {
    const outFile = path.join(tmpdir(), `codex-last-${taskId}.txt`);
    const systemPrompt = buildSystemPrompt(agent);
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;

    // The prompt goes in on stdin ("-"), never as an argv element. On Windows a prompt
    // containing a newline breaks codex's own command-line parsing: everything after the first
    // line gets re-parsed as separate arguments, so the flags that follow it are silently lost
    // and the run dies with a misleading "--skip-git-repo-check was not specified". Any agent
    // with a private system prompt or an attached skill produces a multi-line prompt, so that
    // was every such Codex agent. Reading from stdin has no length limit either.
    const args = [
      "exec",
      "-",
      "--json",
      "--color",
      "never",
      "--skip-git-repo-check",
      "-C",
      cwd,
      "--output-last-message",
      outFile,
      "-s",
      agent?.codexSandbox || "read-only",
    ];
    if (agent?.model) args.push("-m", agent.model);
    const sandbox = agent?.codexSandbox || "read-only";
    if (sandbox === "workspace-write" && agent?.codexNetworkAccess) {
      args.push("-c", "sandbox_workspace_write.network_access=true");
    }

    const bridgeEnv = buildAgentBridgeContext(agent, node, workflow, { runId, taskId, cwd, depth });
    if (bridgeEnv) args.push(...buildCodexBridgeArgs(bridgeEnv));
    args.push(...buildExternalMcpApprovalArgs());

    // Codex is fussy about its argv (see the stdin note above) and its errors point at the
    // wrong flag when something is off, so keep a way to see exactly what was spawned.
    if (process.env.DEBUG_CODEX_ARGS) console.error("[codex argv]", JSON.stringify({ cwd, args }, null, 1));
    const child = spawn("codex", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    trackChild(runId, child, taskId);
    closeBridgeSessionOnExit(child, bridgeEnv);
    // Must be closed, not merely written: codex reads stdin to EOF before starting, so leaving
    // the pipe open would hang the run forever.
    child.stdin.on("error", () => {
      /* codex already exited (e.g. bad flag) — its stderr is the useful error, not EPIPE */
    });
    child.stdin.end(fullPrompt);
    const pushLog = (line) => pushTaskLog(runId, taskId, line);
    let buffer = "";
    let usage = null;
    let stderrText = "";
    const startedAt = Date.now();

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line);
          // `turn.completed` is where Codex reports the turn's token usage (no cost — `codex
          // exec` doesn't surface pricing at all, unlike Claude's total_cost_usd). Silent
          // otherwise: this event carries no message text worth logging.
          if (evt.type === "turn.completed" && evt.usage) {
            usage = normalizeCodexUsage(evt, Date.now() - startedAt);
            continue;
          }
          const toolLine = describeCodexToolCall(evt);
          if (toolLine !== null) {
            if (toolLine) pushLog(toolLine);
            continue;
          }
          const text = extractCodexText(evt);
          pushLog(text ? `💬 ${text}` : `🔧 ${line.length > 300 ? line.slice(0, 300) + "…" : line}`);
        } catch {
          pushLog(line);
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrText += text;
      pushLog(`⚠️ ${text.trim()}`);
    });

    child.on("error", (err) => {
      pushLog(`❌ Lỗi khởi chạy codex CLI: ${err.message}`);
      try {
        rmSync(outFile, { force: true });
      } catch {
        /* ignore */
      }
      resolve({
        ok: false,
        resultText: "",
        usage: null,
        failureReason: classifyAgentFailure({ spawnError: err, exitCode: 1, stderr: stderrText }),
      });
    });

    child.on("close", (code) => {
      let resultText = "";
      try {
        resultText = readFileSync(outFile, "utf-8").trim();
      } catch {
        /* codex didn't write the file (e.g. crashed before finishing) */
      }
      try {
        rmSync(outFile, { force: true });
      } catch {
        /* ignore */
      }
      if (resultText) pushLog(`✅ Kết quả cuối:\n${resultText}`);
      resolve({
        ok: code === 0,
        resultText,
        usage,
        failureReason: classifyAgentFailure({ exitCode: code, stderr: stderrText, resultText }),
      });
    });
  });
}

/** Same normalization as normalizeClaudeUsage, off Codex's `turn.completed` event. Codex
 * exposes no pricing info via `codex exec`, so costUsd stays null rather than guessing at a
 * $/token rate that would go stale the moment OpenAI changes pricing. */
function normalizeCodexUsage(evt, wallDurationMs) {
  const u = evt?.usage || {};
  return {
    provider: "codex",
    inputTokens: Number(u.input_tokens) || 0,
    outputTokens: Number(u.output_tokens) || 0,
    cacheReadTokens: Number(u.cached_input_tokens) || 0,
    cacheCreationTokens: Number(u.cache_write_input_tokens) || 0,
    costUsd: null,
    durationMs: wallDurationMs,
  };
}

/**
 * Renders Codex's `mcp_tool_call` events as readable log lines instead of dumping raw JSONL —
 * this is how an ask_agent call from a Codex node shows up in its task log, matching the
 * `🔧 dùng tool:` lines the Claude path produces. Returns null for anything else.
 *
 * Three-way return: a string to log, "" for a recognized event that should be swallowed, and
 * null for "not a tool call" so the caller falls through to its other handlers. The empty
 * string matters — `item.started` has to be actively suppressed rather than merely unhandled,
 * or it lands in the raw-JSONL fallback and every tool call gets logged twice, once as
 * unreadable JSON and once properly.
 */
function describeCodexToolCall(evt) {
  const item = evt?.item;
  if (item?.type !== "mcp_tool_call") return null;
  // The matching item.completed carries the same arguments plus the outcome.
  if (evt.type === "item.started") return "";
  const name = `${item.server || "mcp"}/${item.tool || "?"}`;
  if (item.error) return `❌ tool ${name} lỗi: ${item.error.message || JSON.stringify(item.error)}`;
  return `🔧 dùng tool: ${name} ${summarizeInput(item.arguments)}`;
}

/** Best-effort text extraction across a few plausible Codex `--json` event shapes; returns
 * null (not "") when nothing recognizable is found so the caller falls back to the raw line. */
function extractCodexText(evt) {
  if (!evt || typeof evt !== "object") return null;
  const candidates = [
    evt.msg?.message,
    evt.msg?.text,
    evt.message,
    evt.text,
    evt.item?.text,
    evt.item?.message,
    evt.delta,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c;
  }
  return null;
}

/** --------------------------- agy (Antigravity CLI, provider "gemini") --------------------------- */

const AGY_BRIDGE_SERVER = "agent-bridge";
const AGY_BRIDGE_ALLOW_RULE = `mcp(${AGY_BRIDGE_SERVER}/*)`;
// Windows caps a whole command line at 32,767 UTF-16 units; leave room for the other flags.
const AGY_MAX_ARGV_PROMPT = 24000;

/**
 * agy has no per-run MCP flag: servers only come from its global ~/.gemini/config/mcp_config.json
 * (managed with `agy mcp add`). So the bridge is registered there once, *without* any context, and
 * each run passes its context (AGENT_BRIDGE_*: session, token, callable list…) through the agy
 * process's own environment — agy starts its MCP servers with that environment. A bridge started
 * by the user's own agy sessions has no context, so it registers no tools and stays inert.
 *
 * Headless agy auto-denies any tool call that would need approval, MCP calls included. The
 * permission it suggests for that is an allow rule in ~/.gemini/antigravity-cli/settings.json;
 * the one added here is scoped to this bridge server only (`mcp(agent-bridge/*)`).
 *
 * Both files are only touched when something is missing or points at an old path, and a settings
 * file that isn't valid JSON is left alone (the run is told why ask_agent may fail).
 */
function ensureAgyBridgeRegistered(log) {
  const configFile = path.join(homedir(), ".gemini", "config", "mcp_config.json");
  let registered = null;
  try {
    registered = JSON.parse(readFileSync(configFile, "utf-8"))?.mcpServers?.[AGY_BRIDGE_SERVER] || null;
  } catch {
    /* no config yet: `agy mcp add` creates it */
  }
  const upToDate =
    registered && !registered.disabled && registered.command === "node" && JSON.stringify(registered.args) === JSON.stringify([BRIDGE_SCRIPT]);
  if (!upToDate) {
    const res = spawn.sync(AGY_BIN, ["mcp", "add", AGY_BRIDGE_SERVER, "node", BRIDGE_SCRIPT], { encoding: "utf-8", timeout: 30000 });
    if (res.error || res.status !== 0) {
      log(`⚠️ Không đăng ký được agent-bridge cho agy: ${res.error?.message || res.stderr || res.stdout}`);
      return;
    }
    log(`ℹ️ Đã đăng ký MCP server "${AGY_BRIDGE_SERVER}" cho agy (một lần, trong ~/.gemini/config/mcp_config.json).`);
  }

  const settingsFile = path.join(homedir(), ".gemini", "antigravity-cli", "settings.json");
  let settings = {};
  try {
    settings = JSON.parse(readFileSync(settingsFile, "utf-8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      log(`⚠️ ${settingsFile} không phải JSON hợp lệ — không thêm quyền cho agent-bridge, ask_agent/spawn_agent có thể bị agy từ chối.`);
      return;
    }
  }
  const allow = settings?.permissions?.allow;
  if (Array.isArray(allow) && allow.includes(AGY_BRIDGE_ALLOW_RULE)) return;
  settings = { ...settings, permissions: { ...(settings.permissions || {}), allow: [...(Array.isArray(allow) ? allow : []), AGY_BRIDGE_ALLOW_RULE] } };
  writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n", "utf-8");
  log(`ℹ️ Đã cho phép agy gọi tool của agent-bridge (${AGY_BRIDGE_ALLOW_RULE} trong ${settingsFile}).`);
}

/** agy's own permission flags for an agent's (already capped) agyMode — see access.js. */
function agyModeArgs(mode) {
  if (mode === "skip") return ["--dangerously-skip-permissions"];
  return ["--mode", mode || "plan"];
}

/**
 * What each agy mode can't do, told to the agent up front. Without it, plan mode tends to answer
 * with a plan artifact and wait for an approval nobody will give, and both modes waste turns on
 * shell commands that headless agy denies (it then ends with no answer at all).
 */
const AGY_MODE_NOTES = {
  plan:
    "Bạn đang ở chế độ CHỈ ĐỌC: được đọc và tìm kiếm (list_dir, view_file, grep_search, find_by_name, đọc web), không sửa file, không chạy lệnh shell. " +
    "Trả lời trực tiếp bằng kết quả, KHÔNG lập kế hoạch và không xin phê duyệt.",
  "accept-edits":
    "Bạn được đọc và sửa file trong thư mục làm việc, nhưng KHÔNG chạy được lệnh shell (sẽ bị từ chối). " +
    "Dùng các tool đọc/sửa file thay cho lệnh shell, và làm luôn chứ không lập kế hoạch rồi chờ phê duyệt.",
};

/**
 * Runs a single headless `agy --print` (Google's Antigravity CLI, which replaced the `gemini`
 * command; already signed in locally — no API key handled here), streaming its
 * `--output-format stream-json` events into the task log.
 *  - Events: `init`, then `step_update` per step (agent_response text arrives as `text_delta`
 *    chunks; tool steps carry tool_name/tool_info and go ACTIVE → DONE/ERROR), then `result`
 *    with status, the final `response`, usage, and any `denied_actions`.
 *  - The prompt goes in as `--print=<prompt>`. agy.exe is a native binary, not an npm .cmd shim,
 *    so newlines survive. A prompt too long for the Windows command line is written to a temp
 *    file instead and the agent is told to read it (the temp dir is added with --add-dir).
 *  - Permissions are the agent's agyMode alone. agy's built-in tools have their own names, so
 *    the Claude per-tool allowlist doesn't apply.
 *  - Skills / private system prompt are prepended to the prompt, as for codex.
 */
function runAgyProcess({ runId, taskId, prompt, cwd, agent, node, workflow, depth = 0, resume = null }) {
  return new Promise((resolve) => {
    const pushLog = (line) => pushTaskLog(runId, taskId, line);
    const systemPrompt = [AGY_MODE_NOTES[agent?.agyMode || "plan"], buildSystemPrompt(agent)].filter(Boolean).join("\n\n");
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;

    let promptFile = null;
    const args = [];
    if (fullPrompt.length > AGY_MAX_ARGV_PROMPT) {
      promptFile = path.join(tmpdir(), `agy-prompt-${taskId}-${randomBytes(4).toString("hex")}.md`);
      writeFileSync(promptFile, fullPrompt, "utf-8");
      args.push(`--print=Toàn bộ yêu cầu nằm trong file ${promptFile}. Đọc hết file đó trước, rồi làm đúng theo yêu cầu trong file.`);
      args.push("--add-dir", tmpdir());
      pushLog(`ℹ️ Prompt dài ${fullPrompt.length} ký tự — gửi qua file ${promptFile}.`);
    } else {
      args.push(`--print=${fullPrompt}`);
    }
    args.push("--output-format", "stream-json", ...agyModeArgs(agent?.agyMode));
    if (agent?.model) args.push("--model", agent.model);
    // Continuing a chat: agy keeps conversations globally, addressed by id.
    if (resume) args.push("--conversation", resume);

    const env = { ...process.env };
    const bridgeEnv = buildAgentBridgeContext(agent, node, workflow, { runId, taskId, cwd, depth });
    if (bridgeEnv) {
      ensureAgyBridgeRegistered(pushLog);
      Object.assign(env, bridgeEnv);
    }
    const cleanup = () => {
      if (!promptFile) return;
      try {
        rmSync(promptFile, { force: true });
      } catch {
        /* ignore */
      }
      promptFile = null;
    };

    const child = spawn(AGY_BIN, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    trackChild(runId, child, taskId);
    closeBridgeSessionOnExit(child, bridgeEnv);

    let buffer = "";
    let stderrText = "";
    let result = null;
    let sessionId = null;
    let lastText = "";
    const stepText = new Map(); // step_index -> agent text so far
    const loggedTools = new Set();
    const startedAt = Date.now();

    const onStep = (u) => {
      if (u.step_type === "agent_response") {
        const text = (stepText.get(u.step_index) || "") + (u.text_delta || "");
        stepText.set(u.step_index, text);
        if (u.state === "DONE" && text.trim()) {
          pushLog(`💬 ${text.trim()}`);
          lastText = text.trim();
        }
      } else if (u.step_type === "tool") {
        const info = u.tool_info || {};
        if (!loggedTools.has(u.step_index)) {
          loggedTools.add(u.step_index);
          const p = info.parameters || {};
          const label = info.name === "call_mcp_tool" ? `${p.ServerName}/${p.ToolName} ${summarizeInput(p.Arguments)}` : `${u.tool_name} ${summarizeInput(p)}`;
          pushLog(`🔧 dùng tool: ${label}`);
        }
        if (u.state === "ERROR") pushLog(`❌ tool ${u.tool_name} lỗi: ${info.error?.message?.split("\n")[0] || "?"}`);
      }
    };

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          pushLog(line);
          continue;
        }
        sessionId = evt.conversation_id || evt.step_update?.conversation_id || evt.result?.conversation_id || sessionId;
        if (evt.event === "init") pushLog(`ℹ️ agy · ${evt.init?.model || "?"} · ${evt.init?.permission_mode || ""}`);
        else if (evt.event === "step_update" && evt.step_update) onStep(evt.step_update);
        else if (evt.event === "result") {
          result = evt.result || {};
          if (result.error) pushLog(`❌ ${result.error}`);
          for (const d of result.denied_actions || []) pushLog(`⚠️ agy đã chặn: ${d.display_name || d.action} (cần quyền "${d.action}")`);
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderrText += text;
      pushLog(`⚠️ ${text.trim()}`);
    });

    child.on("error", (err) => {
      cleanup();
      pushLog(`❌ Lỗi khởi chạy agy CLI: ${err.message}`);
      resolve({ ok: false, resultText: "", usage: null, failureReason: classifyAgentFailure({ spawnError: err, exitCode: 1, stderr: stderrText }) });
    });

    child.on("close", (code) => {
      cleanup();
      const resultText = String(result?.response || "").trim() || lastText;
      if (resultText) pushLog(`✅ Kết quả cuối:\n${resultText}`);
      // A run whose only output was blocked by a permission denial is a failure, not an empty success.
      const blocked = !resultText && (result?.denied_actions || []).length > 0;
      const ok = code === 0 && result?.status === "SUCCESS" && !blocked;
      resolve({
        ok,
        resultText,
        usage: result?.usage ? normalizeAgyUsage(result, Date.now() - startedAt) : null,
        sessionId,
        failureReason: ok ? null : classifyAgentFailure({ exitCode: code || 1, stderr: `${stderrText}\n${result?.error || ""}`, resultText }),
      });
    });
  });
}

/** Same shape as normalizeClaudeUsage, off agy's final `result`. agy's input_tokens include cache
 * reads, so uncached input is the difference; thinking tokens are billed as output. No pricing. */
function normalizeAgyUsage(result, wallDurationMs) {
  const u = result.usage || {};
  const cacheRead = Number(u.cache_read_tokens) || 0;
  return {
    provider: "gemini",
    inputTokens: Math.max(0, (Number(u.input_tokens) || 0) - cacheRead),
    outputTokens: (Number(u.output_tokens) || 0) + (Number(u.thinking_tokens) || 0),
    cacheReadTokens: cacheRead,
    cacheCreationTokens: 0,
    costUsd: null,
    durationMs: typeof result.duration_seconds === "number" ? Math.round(result.duration_seconds * 1000) : wallDurationMs,
  };
}

function summarizeInput(input) {
  if (!input) return "";
  try {
    const s = JSON.stringify(input);
    return s.length > 140 ? s.slice(0, 140) + "…" : s;
  } catch {
    return "";
  }
}

export { runAgentProcess, killRunProcesses, getBridgeSession };
