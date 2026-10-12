import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import spawn from "cross-spawn";
import { nanoid } from "nanoid";
import treeKill from "tree-kill";
import {
  openWorkspaceSession,
  createWorktree,
  integrateWorktree,
  closeWorkspaceSession,
  finalizeWorkspaceReview,
  acceptWorkspaceReview,
  declineWorkspaceReview,
} from "./workspace.js";
import { shouldRenderLogLine } from "./log-utils.js";
import { classifyAgentFailure, finishDelegation, reserveDelegation } from "./delegation-policy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENTS_FILE = path.join(__dirname, "agents.config.json");
const WORKFLOWS_FILE = path.join(__dirname, "workflows.config.json");
const SKILLS_FILE = path.join(__dirname, "skills.config.json");
const PLUGINS_FILE = path.join(__dirname, "plugins.config.json");
const PLUGINS_DIR = path.join(__dirname, "plugins");
const RUNS_FILE = path.join(__dirname, "runs.json");

const DEFAULT_CWD = process.env.TARGET_DIR || path.resolve(__dirname, "..");
const BRIDGE_SCRIPT = path.join(__dirname, "mcp-bridge.js");
const MAX_CALL_DEPTH = 3; // caps agent-calls-agent chains so a bad config can't recurse forever

const MODELS = [
  { value: "", label: "Mặc định (theo cấu hình CLI)" },
  { value: "sonnet", label: "Sonnet 5" },
  { value: "opus", label: "Opus 5" },
  { value: "fable", label: "Fable 5" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

// Claude Code's own built-in sub-agent tool. The CLI calls it "Task" (that exact string is what
// --allowedTools expects), but the UI shows it under a plainer name — "Task" means nothing to a
// user in an app already full of "tasks". Listed explicitly so it's toggleable in the
// allowedTools/disallowedTools UI instead of only working when a tool list is left unrestricted.
const SUBAGENT_TOOL = "Task";

const KNOWN_TOOLS = ["Read", "Edit", "Write", "Bash", "Grep", "Glob", "WebFetch", "WebSearch", "NotebookEdit", SUBAGENT_TOOL];

// Injected automatically when an agent has the sub-agent tool ticked (see buildSystemPrompt).
// Ticking the tool in the UI is meant to be the entire setup — without this the agent *can*
// spawn sub-agents but rarely thinks to, so every prompt had to repeat "use the Task tool...".
const SUBAGENT_SYSTEM_PROMPT = [
  "## Chia việc cho sub-agent",
  'Bạn được phép tạo sub-agent để làm giúp một phần việc: dùng tool `Task` với `subagent_type: "general-purpose"`, mô tả nhiệm vụ, rồi chờ kết quả trả về.',
  "CHỦ ĐỘNG dùng khi công việc có thể tách thành các phần độc lập — khảo sát nhiều thư mục/chủ đề cùng lúc, tra cứu tốn nhiều bước, việc lặp lại trên nhiều file. Không cần người dùng nhắc mới dùng.",
  "KHÔNG dùng khi việc đủ nhỏ để tự làm nhanh hơn, hoặc khi các phần phụ thuộc chặt chẽ vào nhau.",
  "Sub-agent không thấy được hội thoại của bạn: mỗi lần giao việc phải mô tả đầy đủ bối cảnh và nói rõ cần nhận lại thông tin gì. Bạn chịu trách nhiệm tổng hợp kết quả của các sub-agent thành câu trả lời cuối cùng.",
].join("\n");

// Agent "provider" = which local CLI actually runs the agent. Both are spawned as a local,
// already-logged-in CLI (no API key stored by this app) — "claude" (Claude Code CLI, the
// original/default) or "codex" (OpenAI Codex CLI, `codex exec --json ...`).
const PROVIDERS = ["claude", "codex"];
// Maps roughly to Claude's readOnly, but `codex exec` (non-interactive; what we spawn) has
// no approval-prompt flag at all — per `codex exec --help`, `-a/--ask-for-approval` only
// exists on the top-level interactive `codex` command, not `exec`. So sandbox (+ the network
// override below) are the only permission knobs that actually apply here.
const CODEX_SANDBOX_MODES = ["read-only", "workspace-write", "danger-full-access"];

/** The locally-installed Codex CLI already fetches (and caches) the account's real available
 * model list on login — reading it beats hardcoding slugs we'd have no way to keep in sync
 * with what the user's own Codex account actually offers. Falls back to just the blank
 * "CLI default" option if the cache doesn't exist yet (e.g. codex never run once locally). */
function loadCodexModels() {
  const fallback = [{ value: "", label: "Mặc định (theo cấu hình Codex)" }];
  try {
    const file = path.join(homedir(), ".codex", "models_cache.json");
    const data = JSON.parse(readFileSync(file, "utf-8"));
    const models = Array.isArray(data.models) ? data.models : [];
    if (!models.length) return fallback;
    return [
      ...fallback,
      ...models.filter((m) => m.slug).map((m) => ({ value: m.slug, label: m.display_name || m.slug })),
    ];
  } catch {
    return fallback;
  }
}
const CODEX_MODELS = loadCodexModels();

/** Detects whether each provider's CLI is actually installed & on PATH, so the UI can refuse
 * to offer picking a provider that would just fail at spawn time with a confusing ENOENT.
 * Cheap `--version` probe, done once at startup — a CLI being installed/removed mid-session is
 * rare enough that "restart the server to pick it up" is an acceptable tradeoff for not
 * re-probing (and paying a process-spawn cost) on every `/api/meta` request. */
function detectCliAvailable(cmd) {
  try {
    const res = spawn.sync(cmd, ["--version"], { stdio: "ignore" });
    return !res.error;
  } catch {
    return false;
  }
}
const PROVIDER_AVAILABILITY = {
  claude: detectCliAvailable("claude"),
  codex: detectCliAvailable("codex"),
};

/** --------------------------- persistence: agents --------------------------- */

// Agents are re-normalized on load too — e.g. drops the now-removed legacy
// `calleeAgentIds` field (two-way agent calls now live per-node inside a workflow instead).
let AGENTS = loadJson(AGENTS_FILE, []).map((a) => ({ id: String(a.id || nanoid(8)), ...normalizeAgentInput(a) }));
saveAgents();
let SKILLS = loadJson(SKILLS_FILE, []);
let PLUGINS = loadJson(PLUGINS_FILE, []);
// Workflows are migrated (legacy linear `steps` -> `nodes`/`edges` graph) right on load,
// then re-saved once so the file on disk always reflects the current graph shape.
let WORKFLOWS = loadJson(WORKFLOWS_FILE, []).map((w) => ({
  id: String(w.id || nanoid(8)),
  ...normalizeWorkflowInput(w),
}));
saveWorkflows();

function loadJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

function saveAgents() {
  writeFileSync(AGENTS_FILE, JSON.stringify(AGENTS, null, 2), "utf-8");
}

function saveWorkflows() {
  writeFileSync(WORKFLOWS_FILE, JSON.stringify(WORKFLOWS, null, 2), "utf-8");
}

function saveSkills() {
  writeFileSync(SKILLS_FILE, JSON.stringify(SKILLS, null, 2), "utf-8");
}

function savePlugins() {
  writeFileSync(PLUGINS_FILE, JSON.stringify(PLUGINS, null, 2), "utf-8");
}

function listAgents() {
  return AGENTS;
}

function getAgent(agentId) {
  return AGENTS.find((f) => f.id === agentId) || AGENTS[0];
}

function normalizeAgentInput(input) {
  const provider = PROVIDERS.includes(input.provider) ? input.provider : "claude";
  return {
    name: String(input.name || "Unnamed agent").slice(0, 80),
    description: String(input.description || ""),
    provider,
    model: String(input.model || ""),
    readOnly: !!input.readOnly,
    permissionMode: input.permissionMode || (input.readOnly ? "plan" : "acceptEdits"),
    allowedTools: Array.isArray(input.allowedTools) ? input.allowedTools.filter((t) => KNOWN_TOOLS.includes(t)) : [],
    disallowedTools: Array.isArray(input.disallowedTools)
      ? input.disallowedTools.filter((t) => KNOWN_TOOLS.includes(t))
      : [],
    // codex-only knobs (ignored by the claude provider); fall back to something equivalent
    // to readOnly so a freshly-switched agent doesn't silently get full write access.
    codexSandbox: CODEX_SANDBOX_MODES.includes(input.codexSandbox)
      ? input.codexSandbox
      : input.readOnly
        ? "read-only"
        : "workspace-write",
    // Codex's workspace-write sandbox denies outbound network by default (so WebFetch-style
    // commands fail even though file edits are allowed) — this is the one extra permission
    // dimension `codex exec` actually exposes, via `-c sandbox_workspace_write.network_access`.
    // Meaningless (and not passed) outside sandbox=workspace-write.
    codexNetworkAccess: !!input.codexNetworkAccess,
    appendSystemPrompt: String(input.appendSystemPrompt || ""),
    skillIds: Array.isArray(input.skillIds) ? input.skillIds.map(String) : [],
    pluginIds: Array.isArray(input.pluginIds) ? input.pluginIds.map(String) : [],
  };
}

function createAgent(input) {
  const agent = { id: nanoid(8), ...normalizeAgentInput(input) };
  AGENTS.push(agent);
  saveAgents();
  return agent;
}

function updateAgent(id, input) {
  const idx = AGENTS.findIndex((a) => a.id === id);
  if (idx === -1) return null;
  AGENTS[idx] = { id, ...normalizeAgentInput({ ...AGENTS[idx], ...input }) };
  saveAgents();
  return AGENTS[idx];
}

function duplicateAgent(id) {
  const source = AGENTS.find((a) => a.id === id);
  if (!source) return null;
  const { id: _sourceId, ...rest } = source;
  const copyName = `${rest.name} (copy)`.slice(0, 80);
  const agent = { id: nanoid(8), ...normalizeAgentInput({ ...rest, name: copyName }) };
  AGENTS.push(agent);
  saveAgents();
  return agent;
}

function deleteAgent(id) {
  const usedByWorkflows = WORKFLOWS.filter((w) => w.nodes.some((n) => n.agentId === id)).map((w) => w.name);
  if (usedByWorkflows.length) {
    throw new Error(
      `Agent đang được dùng trong workflow: ${usedByWorkflows.join(", ")}. Gỡ khỏi (các) workflow đó trước rồi mới xoá.`
    );
  }
  const before = AGENTS.length;
  AGENTS = AGENTS.filter((a) => a.id !== id);
  saveAgents();
  return AGENTS.length < before;
}

/** --------------------------- persistence: workflows --------------------------- */

function listWorkflows() {
  return WORKFLOWS;
}

function getWorkflow(id) {
  return WORKFLOWS.find((w) => w.id === id);
}

/**
 * Workflow shape: { name, description, nodes: [{id, agentId, promptTemplate, kind}], edges: [{id, from, to, condition}] }
 * kind: "agent" (normal step) | "router" (its result picks exactly one outgoing edge by matching `condition`)
 * An edge with no `condition` is a plain fan-out/fan-in link (always taken once its source resolves).
 *
 * Back-compat: legacy `{ steps: [{agentId, promptTemplate}] }` (strict linear chain) is auto-migrated
 * into an equivalent nodes/edges graph so old saved workflows keep working untouched.
 */
function normalizeWorkflowInput(input) {
  let rawNodes = Array.isArray(input.nodes) ? input.nodes : null;
  let rawEdges = Array.isArray(input.edges) ? input.edges : null;

  if (!rawNodes && Array.isArray(input.steps)) {
    const steps = input.steps.filter((s) => s && s.agentId);
    rawNodes = steps.map((s, i) => ({
      id: `n${i}`,
      agentId: s.agentId,
      promptTemplate: s.promptTemplate || "",
      kind: "agent",
    }));
    rawEdges = rawNodes.slice(0, -1).map((n, i) => ({ from: n.id, to: rawNodes[i + 1].id }));
  }

  const nodes = (rawNodes || [])
    .filter((n) => n && n.agentId)
    .map((n) => ({
      id: String(n.id ?? nanoid(6)),
      agentId: String(n.agentId),
      promptTemplate: String(n.promptTemplate || ""),
      kind: n.kind === "router" ? "router" : "agent",
      // Two-way interaction, scoped to THIS workflow: other node ids in this same graph
      // that this node may call synchronously (ask & wait for the full answer) mid-run,
      // via the ask_agent MCP tool — independent of the node's own in/out edges.
      calleeNodeIds: Array.isArray(n.calleeNodeIds) ? n.calleeNodeIds.map(String) : [],
      // false = this node never runs on its own as part of the graph (not a root, edges
      // into/out of it are ignored) — it only runs when another node calls it via
      // ask_agent. Lets a caller node fully control ordering itself (call A, wait, call B)
      // instead of the graph auto-fanning-out to both in parallel.
      autoStart: n.autoStart !== false,
      // Manual canvas position (editor drag-and-drop); omitted -> client auto-places it.
      ...(typeof n.x === "number" && typeof n.y === "number" ? { x: n.x, y: n.y } : {}),
    }));
  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    n.calleeNodeIds = n.calleeNodeIds.filter((id) => nodeIds.has(id) && id !== n.id);
  }

  const edges = (rawEdges || [])
    .filter((e) => e && nodeIds.has(e.from) && nodeIds.has(e.to) && e.from !== e.to)
    .map((e) => ({
      id: String(e.id ?? nanoid(6)),
      from: String(e.from),
      to: String(e.to),
      condition: String(e.condition || ""),
    }));

  return {
    name: String(input.name || "Unnamed workflow").slice(0, 80),
    description: String(input.description || ""),
    nodes,
    edges,
    isolation: normalizeIsolationInput(input.isolation),
  };
}

/**
 * Per-workflow git-worktree isolation (see server/workspace.js). Off by default so existing
 * saved workflows keep behaving exactly as before — turning it on changes where agents write.
 *  - enabled:       isolate each branch of a parallel fan-out into its own worktree
 *  - testCommand:   run inside each worktree before merging back; empty = merge without testing
 *  - keepOnFailure: leave the worktree + temp branch on disk when tests fail / merge conflicts
 */
function normalizeIsolationInput(input) {
  return {
    enabled: !!input?.enabled,
    testCommand: String(input?.testCommand || "").slice(0, 500),
    keepOnFailure: input?.keepOnFailure !== false,
  };
}

function createWorkflow(input) {
  const workflow = { id: nanoid(8), ...normalizeWorkflowInput(input) };
  WORKFLOWS.push(workflow);
  saveWorkflows();
  return workflow;
}

function updateWorkflow(id, input) {
  const idx = WORKFLOWS.findIndex((w) => w.id === id);
  if (idx === -1) return null;
  WORKFLOWS[idx] = { id, ...normalizeWorkflowInput({ ...WORKFLOWS[idx], ...input }) };
  saveWorkflows();
  return WORKFLOWS[idx];
}

function deleteWorkflow(id) {
  const before = WORKFLOWS.length;
  WORKFLOWS = WORKFLOWS.filter((w) => w.id !== id);
  saveWorkflows();
  return WORKFLOWS.length < before;
}

/** --------------------------- persistence: skills --------------------------- */

function listSkills() {
  return SKILLS;
}

function getSkill(id) {
  return SKILLS.find((s) => s.id === id);
}

function normalizeSkillInput(input) {
  return {
    name: String(input.name || "Unnamed skill").slice(0, 80),
    description: String(input.description || ""),
    content: String(input.content || ""),
  };
}

function createSkill(input) {
  const skill = { id: nanoid(8), ...normalizeSkillInput(input) };
  SKILLS.push(skill);
  saveSkills();
  return skill;
}

function updateSkill(id, input) {
  const idx = SKILLS.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  SKILLS[idx] = { id, ...normalizeSkillInput({ ...SKILLS[idx], ...input }) };
  saveSkills();
  return SKILLS[idx];
}

function deleteSkill(id) {
  const usedByAgents = AGENTS.filter((a) => a.skillIds?.includes(id)).map((a) => a.name);
  if (usedByAgents.length) {
    throw new Error(`Skill đang được dùng bởi agent: ${usedByAgents.join(", ")}. Gỡ khỏi (các) agent đó trước rồi mới xoá.`);
  }
  const before = SKILLS.length;
  SKILLS = SKILLS.filter((s) => s.id !== id);
  saveSkills();
  return SKILLS.length < before;
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
  // the tool is technically reachable. Claude-only: `codex exec` has no equivalent tool.
  if (agent?.provider !== "codex" && agent?.allowedTools?.includes(SUBAGENT_TOOL)) {
    parts.push(SUBAGENT_SYSTEM_PROMPT);
  }
  return parts.join("\n\n");
}

/**
 * Context for wiring the running node up to `mcp-bridge.js`, the stdio MCP server exposing one
 * tool (`ask_agent`) that lets the node call another node's agent synchronously — send a
 * question, block until that agent's full answer comes back, then continue with it.
 *
 * Provider-neutral on purpose: `mcp-bridge.js` is a plain stdio MCP server with nothing
 * Claude-specific in it, so the same process serves both CLIs and only the flags that point at
 * it differ (buildClaudeBridgeArgs / buildCodexBridgeArgs below).
 *
 * Scoped to a single workflow: `node` must belong to `workflow`, and only nodes listed in
 * `node.calleeNodeIds` (configured in the workflow editor) are reachable. Returns null outside
 * a workflow run, when the node has no callees configured, or the call chain is already at
 * MAX_CALL_DEPTH (so a callee that also has callees can't recurse forever).
 */
function buildAgentBridgeContext(node, workflow, { runId, taskId, cwd, depth }) {
  if (!node?.calleeNodeIds?.length || !workflow || depth >= MAX_CALL_DEPTH) return null;
  const callable = node.calleeNodeIds
    .map((id) => workflow.nodes.find((n) => n.id === id))
    .filter(Boolean)
    .map((n) => ({ id: n.id, name: nodeTitle(n), description: getAgent(n.agentId)?.description || "" }));
  if (!callable.length) return null;

  return {
    AGENT_BRIDGE_URL: `http://localhost:${process.env.PORT || 5175}`,
    AGENT_BRIDGE_RUN_ID: runId || "",
    AGENT_BRIDGE_TASK_ID: taskId || "",
    AGENT_BRIDGE_WORKFLOW_ID: workflow.id || "",
    AGENT_BRIDGE_CALLER_NODE_ID: node.id || "",
    AGENT_BRIDGE_DEPTH: String(depth),
    AGENT_BRIDGE_CWD: cwd || "",
    AGENT_BRIDGE_CALLABLE: JSON.stringify(callable),
  };
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

/** --------------------------- persistence: plugins (real Claude Code plugins) --------------------------- */

function listPlugins() {
  return PLUGINS;
}

function getPlugin(id) {
  return PLUGINS.find((p) => p.id === id);
}

/**
 * A plugin references a real Claude Code plugin (a directory with a
 * `.claude-plugin/plugin.json` manifest, e.g. https://github.com/DietrichGebert/ponytail).
 * sourceType:
 *  - "git"  -> sourceValue is a git URL; we `git clone` it once into server/plugins/<id>
 *              and pass `--plugin-dir <clonedPath>` to `claude` for agents that use it.
 *  - "dir"  -> sourceValue is an already-local directory path; used as-is with `--plugin-dir`.
 *  - "url"  -> sourceValue is a URL to a plugin .zip; passed as `--plugin-url`.
 */
function createPlugin(input) {
  const id = nanoid(8);
  const name = String(input.name || "Unnamed plugin").slice(0, 80);
  const description = String(input.description || "");
  const sourceType = ["git", "dir", "url"].includes(input.sourceType) ? input.sourceType : "git";
  const sourceValue = String(input.sourceValue || "").trim();
  if (!sourceValue) throw new Error("Thiếu sourceValue (git URL / đường dẫn / plugin URL)");

  let localPath = "";
  if (sourceType === "git") {
    localPath = path.join(PLUGINS_DIR, id);
    execFileSync("git", ["clone", "--depth", "1", sourceValue, localPath], { stdio: "pipe" });
  } else if (sourceType === "dir") {
    if (!existsSync(sourceValue)) throw new Error(`Không tìm thấy thư mục: ${sourceValue}`);
    localPath = sourceValue;
  }

  const plugin = { id, name, description, sourceType, sourceValue, localPath };
  PLUGINS.push(plugin);
  savePlugins();
  return plugin;
}

function updatePlugin(id, input) {
  const idx = PLUGINS.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  const existing = PLUGINS[idx];
  PLUGINS[idx] = {
    ...existing,
    name: input.name !== undefined ? String(input.name).slice(0, 80) : existing.name,
    description: input.description !== undefined ? String(input.description) : existing.description,
  };
  savePlugins();
  return PLUGINS[idx];
}

function deletePlugin(id) {
  const plugin = getPlugin(id);
  if (!plugin) return false;
  if (plugin.sourceType === "git" && plugin.localPath && plugin.localPath.startsWith(PLUGINS_DIR)) {
    try {
      rmSync(plugin.localPath, { recursive: true, force: true });
    } catch {
      /* ignore cleanup failure */
    }
  }
  PLUGINS = PLUGINS.filter((p) => p.id !== id);
  savePlugins();
  let touched = false;
  for (const a of AGENTS) {
    if (a.pluginIds?.includes(id)) {
      a.pluginIds = a.pluginIds.filter((pid) => pid !== id);
      touched = true;
    }
  }
  if (touched) saveAgents();
  return true;
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

/** --------------------------- runs --------------------------- */

/** In-memory store: runId -> run object, persisted to runs.json so history/logs survive a
 * server restart (previously in-memory only — lost on every restart). */
const runs = new Map();

/**
 * Claude's account-wide rate-limit status, opportunistically captured off the `rate_limit_event`
 * line every `claude -p --output-format stream-json` call already emits (see runClaudeProcess) —
 * no extra request, no extra cost, just read off traffic that was happening anyway. It's
 * account-level, not per-agent/per-run, hence one shared value here rather than living on a task.
 * Resets to null on server restart and is filled again by the next Claude run; there is no
 * "fetch it right now for free" call, so the UI shows this as "as of <last run>" rather than live.
 *
 * Codex has no equivalent: `codex exec --json` (checked against CLI 0.146.0) never emits a
 * rate-limit/quota event — its help output has no `codex usage`/`codex quota` subcommand either.
 * So this stays Claude-only; the client is told to say so rather than fabricate a Codex number.
 */
let lastClaudeQuota = null;

function saveRuns() {
  try {
    writeFileSync(RUNS_FILE, JSON.stringify([...runs.values()], null, 2), "utf-8");
  } catch (err) {
    console.error("[orchestrator] Không lưu được runs.json:", err.message);
  }
}

// Throttled (not debounced): during a burst of events (e.g. streaming log lines) this saves at
// most once every ~400ms rather than on every single line, while still guaranteeing a save
// lands soon after any change — including the very last event of a run, since the timeout
// re-reads `runs` fresh when it fires, not a stale snapshot taken when it was scheduled.
let saveRunsTimer = null;
function scheduleSaveRuns() {
  if (saveRunsTimer) return;
  saveRunsTimer = setTimeout(() => {
    saveRunsTimer = null;
    saveRuns();
  }, 400);
}

/** Loads persisted runs on startup. A run (or task) still `status: "running"` in the saved
 * file means the server process died mid-run — the spawned CLI child is long gone and can't be
 * resumed, so it's marked as errored rather than silently stuck "running" forever. Whatever
 * log/output had already accumulated before the crash is kept as-is. */
function loadRuns() {
  const raw = loadJson(RUNS_FILE, []);
  for (const r of raw) {
    if (r.status === "running") {
      r.status = "error";
      r.error =
        r.error ||
        "Server đã dừng trong khi run này đang chạy dở — tiến trình bị ngắt. Log/kết quả đã có tới lúc đó vẫn được giữ nguyên. " +
        "Nếu là run theo workflow, bấm \"Chạy tiếp\" để chạy lại từ bước bị gián đoạn thay vì làm lại từ đầu.";
    }
    for (const t of r.tasks || []) {
      if (t.status === "running") t.status = "error";
    }
    for (const delegation of r.delegations || []) {
      if (delegation.status === "running") {
        delegation.status = "error";
        delegation.failureReason = "interrupted";
        delegation.finishedAt = Date.now();
      }
    }
    runs.set(r.id, r);
  }
}
loadRuns();

/** --------------------------- stopping a run --------------------------- */

/** runId -> live ChildProcess objects spawned for that run. A run can have several at once
 * (parallel branches, plus any ask_agent callee running inside one of them). */
const liveChildren = new Map();

/** Runs the user asked to stop. Separate from the child processes on purpose: killing what's
 * currently running isn't enough, the graph/subtask loops also have to stop *scheduling* the
 * work that hasn't started yet, and they check this. Cleared when a run is resumed. */
const cancelling = new Set();

const isCancelling = (runId) => cancelling.has(runId);

function trackChild(runId, child) {
  if (!liveChildren.has(runId)) liveChildren.set(runId, new Set());
  const set = liveChildren.get(runId);
  set.add(child);
  const drop = () => {
    set.delete(child);
    if (!set.size) liveChildren.delete(runId);
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

/**
 * Marks a run as stopping and kills every process it currently owns. Returns once the signals
 * are sent — the run's own loop notices `cancelling`, finishes unwinding (including cleaning up
 * any git worktrees), and is what actually flips the run to `cancelled`.
 */
function stopRun(runId) {
  const run = runs.get(runId);
  if (!run) return false;
  if (run.status !== "running") {
    throw new Error("Run này không còn chạy — không có gì để dừng.");
  }
  cancelling.add(runId);
  emit({ runId, type: "run-status", status: "running", stopping: true });

  for (const task of run.tasks) {
    if (task.status === "running") pushTaskLog(runId, task.id, "🛑 Người dùng yêu cầu dừng — đang kết thúc tiến trình...");
  }
  for (const child of [...(liveChildren.get(runId) || [])]) killTree(child.pid);
  // No live child (e.g. stopped in the gap between two nodes) — the loop still picks up the
  // flag on its next iteration and stops there.
  return true;
}

/** Set of listener callbacks(event) for broadcasting to WS clients */
const listeners = new Set();

function emit(event) {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      /* ignore */
    }
  }
  scheduleSaveRuns();
}

function pushTaskLog(runId, taskId, line) {
  const normalized = String(line || "").trim();
  if (!shouldRenderLogLine(normalized)) return;

  const run = runs.get(runId);
  const task = run?.tasks.find((t) => t.id === taskId);
  if (task) task.log.push(normalized);
  emit({ runId, taskId, type: "log", line: normalized });
}

function listRuns() {
  return [...runs.values()]
    .map(summarize)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function summarize(run, { includeReviewPatch = false } = {}) {
  const review = run.review
    ? {
      ...run.review,
      patch: includeReviewPatch ? run.review.patch || "" : undefined,
    }
    : null;
  return {
    id: run.id,
    prompt: run.prompt,
    agentId: run.agentId,
    workflowId: run.workflowId,
    workflowNodes: run.workflowNodes || null,
    workflowEdges: run.workflowEdges || null,
    decompose: run.decompose,
    cwd: run.cwd,
    status: run.status,
    error: run.error || null,
    createdAt: run.createdAt,
    stopping: run.status === "running" && isCancelling(run.id),
    resumable: canResume(run),
    review,
    tasks: run.tasks.map((t) => ({
      id: t.id,
      nodeId: t.nodeId || null,
      title: t.title,
      kind: t.kind,
      status: t.status,
      log: t.log,
      resultText: t.resultText,
      provider: t.provider || null,
      agentId: t.agentId || null,
      agentName: t.agentName || null,
      workItemId: t.workItemId || null,
      parentWorkItemId: t.parentWorkItemId || null,
      failureReason: t.failureReason || null,
      usage: t.usage || null,
    })),
  };
}

/**
 * Rolls up every task's `usage` (see normalizeClaudeUsage/normalizeCodexUsage) across all
 * persisted runs into per-provider totals, plus a per-agent breakdown so "which agent burns the
 * most tokens" is answerable without scraping run history by hand. Recomputed on each request
 * rather than kept as a running counter — usage figures live on the tasks themselves (already
 * persisted in runs.json), so this is just an aggregate view over data that already exists, and
 * staying stateless means deleting/clearing run history is automatically reflected too.
 */
function getUsageSummary() {
  const empty = () => ({
    tasks: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    hasCost: false,
    durationMs: 0,
  });
  const byProvider = { claude: empty(), codex: empty() };
  const byAgent = new Map(); // agentId -> { agentId, agentName, provider, ...empty() }

  for (const run of runs.values()) {
    for (const t of run.tasks) {
      const u = t.usage;
      if (!u || !byProvider[u.provider]) continue;

      const p = byProvider[u.provider];
      p.tasks++;
      p.inputTokens += u.inputTokens || 0;
      p.outputTokens += u.outputTokens || 0;
      p.cacheReadTokens += u.cacheReadTokens || 0;
      p.cacheCreationTokens += u.cacheCreationTokens || 0;
      p.durationMs += u.durationMs || 0;
      if (typeof u.costUsd === "number") {
        p.costUsd += u.costUsd;
        p.hasCost = true;
      }

      const agentKey = t.agentId || `unknown-${u.provider}`;
      if (!byAgent.has(agentKey)) {
        byAgent.set(agentKey, {
          agentId: t.agentId || null,
          agentName: t.agentName || "(agent đã xoá)",
          provider: u.provider,
          ...empty(),
        });
      }
      const a = byAgent.get(agentKey);
      a.tasks++;
      a.inputTokens += u.inputTokens || 0;
      a.outputTokens += u.outputTokens || 0;
      a.cacheReadTokens += u.cacheReadTokens || 0;
      a.cacheCreationTokens += u.cacheCreationTokens || 0;
      a.durationMs += u.durationMs || 0;
      if (typeof u.costUsd === "number") {
        a.costUsd += u.costUsd;
        a.hasCost = true;
      }
    }
  }

  return {
    byProvider,
    byAgent: [...byAgent.values()].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)),
    quota: {
      // { status, resetsAt, rateLimitType, utilization, isUsingOverage, updatedAt } | null — see
      // lastClaudeQuota above for why this is opportunistic/account-wide rather than live-fetched.
      claude: lastClaudeQuota,
      // Not a bug we can fix client-side: codex exec --json has no rate-limit event to read.
      codexAvailable: false,
    },
  };
}

function getRun(runId) {
  const run = runs.get(runId);
  return run ? summarize(run, { includeReviewPatch: true }) : null;
}

async function acceptRunReview(runId) {
  const run = runs.get(runId);
  if (!run) return false;
  if (run.status === "running") throw new Error("Run vẫn đang chạy.");
  if (run.review?.status !== "pending") throw new Error("Run không có thay đổi đang chờ review.");
  await acceptWorkspaceReview(run.review);
  run.review = { ...run.review, status: "accepted", decidedAt: Date.now() };
  emit({ runId, type: "review-status", status: "accepted" });
  saveRuns();
  return true;
}

async function declineRunReview(runId) {
  const run = runs.get(runId);
  if (!run) return false;
  if (run.status === "running") throw new Error("Run vẫn đang chạy.");
  if (run.review?.status !== "pending") throw new Error("Run không có thay đổi đang chờ review.");
  await declineWorkspaceReview(run.review);
  run.review = { ...run.review, status: "declined", decidedAt: Date.now() };
  emit({ runId, type: "review-status", status: "declined" });
  saveRuns();
  return true;
}

/** Deletes one run from history. Refuses to delete a still-`running` run — its spawned CLI
 * process is still writing into `run.tasks[].log` by reference; deleting the Map entry out
 * from under it wouldn't stop that process, just orphan its output nowhere the UI can show it. */
function deleteRun(id) {
  const run = runs.get(id);
  if (!run) return false;
  if (run.status === "running") {
    throw new Error("Không thể xoá run đang chạy. Đợi run hoàn tất (hoặc lỗi) rồi mới xoá.");
  }
  if (run.review?.status === "pending") {
    throw new Error("Hãy Accept hoặc Decline thay đổi trước khi xoá run.");
  }
  runs.delete(id);
  saveRuns();
  emit({ runId: id, type: "run-deleted" });
  return true;
}

/** Clears all run history except runs still `running` (same reasoning as deleteRun) — those
 * are silently kept rather than erroring out a bulk "clear all" action. */
function clearRuns() {
  let cleared = 0;
  let kept = 0;
  for (const [id, run] of runs) {
    if (run.status === "running" || run.review?.status === "pending") {
      kept++;
    } else {
      runs.delete(id);
      cleared++;
    }
  }
  saveRuns();
  emit({ type: "runs-cleared" });
  return { cleared, kept };
}

/** Dispatches to the right local CLI based on the agent's `provider` — same {ok, resultText}
 * shape either way, so every call site (ad-hoc run, workflow node, ask_agent) stays provider-agnostic.
 * `node`/`workflow`/`depth` (the two-way ask_agent bridge) now apply to both providers; only
 * `extraArgs` is claude-specific. */
function runAgentProcess(opts) {
  const provider = opts.agent?.provider === "codex" ? "codex" : "claude";
  // Defense in depth: the UI already refuses to let you pick an unavailable provider (see
  // PROVIDER_AVAILABILITY / /api/meta), but an agent saved before a CLI was uninstalled — or
  // reused from an export made on a different machine — could still reach here. Fail with a
  // clear message instead of a raw spawn ENOENT.
  if (!PROVIDER_AVAILABILITY[provider]) {
    const cmd = provider === "codex" ? "codex" : "claude";
    pushTaskLog(
      opts.runId,
      opts.taskId,
      `❌ CLI "${cmd}" không được cài đặt hoặc không có trong PATH của server. Cài đặt rồi khởi động lại server để dùng provider "${provider}".`
    );
    return Promise.resolve({ ok: false, resultText: "", usage: null, failureReason: "provider_unavailable" });
  }
  return provider === "codex" ? runCodexProcess(opts) : runClaudeProcess(opts);
}

/** Runs a single `claude -p` process, streams stdout(JSONL) as events, resolves final text. */
function runClaudeProcess({ runId, taskId, prompt, cwd, agent, node, workflow, extraArgs = [], depth = 0 }) {
  return new Promise((resolve) => {
    // --forward-subagent-text: when this agent uses Claude Code's own Task tool to spawn a
    // subagent, that subagent's text/thinking gets forwarded into this same stream-json output
    // (as assistant/user messages) instead of vanishing into the parent's summarized result —
    // so subagent activity actually shows up in this task's log below, not just its outcome.
    const args = [
      "-p",
      prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--forward-subagent-text",
      ...extraArgs,
    ];
    const AGENT_BRIDGE_TOOL = "mcp__agent-bridge__ask_agent";

    if (agent?.model) args.push("--model", agent.model);
    if (agent?.permissionMode) args.push("--permission-mode", agent.permissionMode);

    const bridgeEnv = buildAgentBridgeContext(node, workflow, { runId, taskId, cwd, depth });
    // An empty allowedTools list normally means "no restriction" (no flag passed at all).
    // Once agent-bridge is wired in we must pass an explicit list so the new MCP tool is
    // allowed too — so an originally-unrestricted agent falls back to the same tool set our
    // own UI lets you toggle (KNOWN_TOOLS), plus ask_agent.
    let allowedTools = agent?.allowedTools?.length ? agent.allowedTools.slice() : bridgeEnv ? KNOWN_TOOLS.slice() : [];
    if (bridgeEnv) allowedTools.push(AGENT_BRIDGE_TOOL);
    if (allowedTools.length) args.push("--allowedTools", allowedTools.join(" "));
    if (agent?.disallowedTools?.length) args.push("--disallowedTools", agent.disallowedTools.join(" "));
    if (bridgeEnv) args.push(...buildClaudeBridgeArgs(bridgeEnv));

    const systemPrompt = buildSystemPrompt(agent);
    if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
    args.push(...buildPluginArgs(agent));

    const child = spawn("claude", args, { cwd });
    trackChild(runId, child);
    let buffer = "";
    let resultText = "";
    let usage = null;
    let stderrText = "";
    let quotaSignal = false;
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
            lastClaudeQuota = { ...r, updatedAt: Date.now() };
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
      pushLog(`❌ Lỗi khởi chạy claude CLI: ${err.message}`);
      resolve({
        ok: false,
        resultText: "",
        usage: null,
        failureReason: classifyAgentFailure({ spawnError: err, exitCode: 1, stderr: stderrText }),
      });
    });

    child.on("close", (code) => {
      resolve({
        ok: code === 0,
        resultText,
        usage,
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
      agent?.codexSandbox || (agent?.readOnly ? "read-only" : "workspace-write"),
    ];
    if (agent?.model) args.push("-m", agent.model);
    const sandbox = agent?.codexSandbox || (agent?.readOnly ? "read-only" : "workspace-write");
    if (sandbox === "workspace-write" && agent?.codexNetworkAccess) {
      args.push("-c", "sandbox_workspace_write.network_access=true");
    }

    const bridgeEnv = buildAgentBridgeContext(node, workflow, { runId, taskId, cwd, depth });
    if (bridgeEnv) args.push(...buildCodexBridgeArgs(bridgeEnv));
    args.push(...buildExternalMcpApprovalArgs());

    // Codex is fussy about its argv (see the stdin note above) and its errors point at the
    // wrong flag when something is off, so keep a way to see exactly what was spawned.
    if (process.env.DEBUG_CODEX_ARGS) console.error("[codex argv]", JSON.stringify({ cwd, args }, null, 1));
    const child = spawn("codex", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    trackChild(runId, child);
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

function summarizeInput(input) {
  if (!input) return "";
  try {
    const s = JSON.stringify(input);
    return s.length > 140 ? s.slice(0, 140) + "…" : s;
  } catch {
    return "";
  }
}

async function decomposePrompt({ runId, taskId, prompt, cwd }) {
  const planPrompt = [
    "Hãy chia nhỏ yêu cầu sau thành các subtask độc lập, mỗi subtask nên đủ nhỏ để một agent lập trình riêng có thể thực hiện.",
    "CHỈ trả lời bằng một JSON array of strings, không thêm giải thích, không markdown code fence.",
    "Nếu yêu cầu đã đủ nhỏ, trả về mảng chỉ có 1 phần tử.",
    "",
    `Yêu cầu: ${prompt}`,
  ].join("\n");

  const { resultText } = await runAgentProcess({
    runId,
    taskId,
    prompt: planPrompt,
    cwd,
    agent: { permissionMode: "plan", allowedTools: [] },
  });

  try {
    const match = resultText.match(/\[[\s\S]*\]/);
    const arr = JSON.parse(match ? match[0] : resultText);
    if (Array.isArray(arr) && arr.length && arr.every((x) => typeof x === "string")) {
      return arr;
    }
  } catch {
    /* fall through */
  }
  return [prompt];
}

// `agent` is optional and only meaningful for task kinds that actually spawn a CLI (agent,
// agent-call, workflow-node, workflow-router) — recorded up front (not just usage, after the
// fact) so a task still shows which provider/agent it ran under even if the process errors out
// before producing any usage numbers. See getUsageSummary() for how this rolls up.
function newTask(title, kind, nodeId = null, agent = null) {
  return {
    id: nanoid(8),
    nodeId,
    title,
    kind,
    status: "pending",
    log: [],
    resultText: "",
    provider: agent ? (agent.provider === "codex" ? "codex" : "claude") : null,
    agentId: agent?.id || null,
    agentName: agent?.name || null,
    usage: null,
  };
}

/**
 * Two-way agent interaction: called (via the HTTP endpoint the mcp-bridge process hits)
 * while `callerNodeId` (a node inside the running `workflowId`) is mid-run inside `runId`.
 * Permission is scoped to that one workflow's graph: `callerNodeId` must list
 * `targetNodeId` in its own `calleeNodeIds` (set in the workflow editor, not on the agent).
 * Spawns the target node's agent synchronously, appends the exchange as its own task in
 * the same run (visible in the UI right alongside whatever triggered it), and returns the
 * callee's full answer text back to the caller's `ask_agent` tool call so it can continue.
 */
async function askAgent({ runId, workflowId, callerNodeId, targetNodeId, question, workItemId, parentWorkItemId, cwd, depth }) {
  const run = runs.get(runId);
  if (!run) throw new Error("Run không tồn tại (có thể đã kết thúc).");
  if (depth >= MAX_CALL_DEPTH) throw new Error("Đã đạt giới hạn độ sâu gọi agent (chống vòng lặp gọi nhau).");

  const workflow = getWorkflow(workflowId);
  if (!workflow) throw new Error("Workflow không tồn tại.");
  const callerNode = workflow.nodes.find((n) => n.id === callerNodeId);
  if (!callerNode?.calleeNodeIds?.includes(targetNodeId)) {
    throw new Error("Bước này chưa được cấp quyền gọi bước đó (thêm ở phần \"Nhánh có thể gọi (2 chiều)\" trong Workflow editor).");
  }
  if (targetNodeId === callerNodeId) throw new Error("Một bước không được tự gọi chính nó.");

  const targetNode = workflow.nodes.find((n) => n.id === targetNodeId);
  if (!targetNode) throw new Error("Bước đích không còn tồn tại trong workflow.");
  const targetAgent = getAgent(targetNode.agentId);

  const task = newTask(`💬 ${nodeTitle(callerNode)} giao [${workItemId}] cho ${nodeTitle(targetNode)}`, "agent-call", targetNode.id, targetAgent);
  const delegation = reserveDelegation(run, {
    callerNodeId,
    targetNodeId,
    workItemId,
    parentWorkItemId,
    question,
    assignmentId: task.id,
  });
  task.workItemId = delegation.workItemId;
  task.parentWorkItemId = delegation.parentWorkItemId;
  run.tasks.push(task);
  emit({ runId, taskId: task.id, type: "task-created", task });
  task.status = "running";
  emit({ runId, taskId: task.id, type: "task-status", status: "running" });
  pushTaskLog(runId, task.id, `❓ ${question}`);

  let processResult;
  try {
    processResult = await runAgentProcess({
      runId,
      taskId: task.id,
      prompt: question,
      cwd,
      agent: targetAgent,
      node: targetNode,
      workflow,
      depth: depth + 1,
    });
  } catch (err) {
    pushTaskLog(runId, task.id, `❌ Lỗi nội bộ khi chạy agent: ${err.message}`);
    processResult = { ok: false, resultText: "", usage: null, failureReason: "agent_error" };
  }
  const { ok, resultText, usage, failureReason } = processResult;

  task.resultText = resultText;
  task.usage = usage;
  task.failureReason = failureReason || null;
  task.status = isCancelling(runId) ? "cancelled" : ok ? "done" : "error";
  finishDelegation(delegation, {
    ok: task.status === "done",
    failureReason: task.status === "cancelled" ? "cancelled" : failureReason,
  });
  emit({ runId, taskId: task.id, type: "task-status", status: task.status });

  return { answer: resultText, ok: task.status === "done", failureReason: task.failureReason };
}

/** --------------------------- ad-hoc single-agent run (optionally auto-decomposed) --------------------------- */

async function startRun({ prompt, agentId, decompose, cwd }) {
  const agent = getAgent(agentId);
  const runId = nanoid(10);
  const run = {
    id: runId,
    prompt,
    agentId: agent.id,
    workflowId: null,
    decompose: !!decompose,
    cwd: cwd || DEFAULT_CWD,
    status: "running",
    createdAt: Date.now(),
    tasks: [],
  };
  runs.set(runId, run);
  emit({ runId, type: "run-created", run: summarize(run) });

  process.nextTick(() =>
    executeRun(run, agent).catch((err) => {
      run.status = "error";
      run.error = err.message;
      emit({ runId, type: "run-status", status: "error", error: err.message });
    })
  );

  return runId;
}

async function executeRun(run, agent) {
  const { id: runId, prompt, decompose } = run;
  const { workspace, fatal } = await openRunWorkspace(run, { isolation: {} });
  if (!workspace && fatal) {
    run.status = "error";
    run.error = run.review?.reason;
    cancelling.delete(runId);
    emit({ runId, type: "run-status", status: "error", error: run.error });
    return;
  }
  // No workspace = not a git repo, so there's nothing to review against: run where the user
  // pointed us, same as before review existed.
  const executionCwd = workspace ? workspace.session.reviewDir : run.cwd;

  // Same shape as executeWorkflowRun: whatever happens in the body, the review has to be sealed
  // and the session torn down. Skipping it would strand the agent's work in a worktree the user
  // has no way to reach — no diff shown, no Accept, no Decline.
  try {
    let subtasks = [prompt];

    if (decompose) {
      const plannerTask = newTask("Planner: chia nhỏ yêu cầu", "planner");
      run.tasks.push(plannerTask);
      emit({ runId, taskId: plannerTask.id, type: "task-created", task: plannerTask });
      plannerTask.status = "running";
      emit({ runId, taskId: plannerTask.id, type: "task-status", status: "running" });

      subtasks = await decomposePrompt({ runId, taskId: plannerTask.id, prompt, cwd: executionCwd });

      plannerTask.status = isCancelling(runId) ? "cancelled" : "done";
      emit({ runId, taskId: plannerTask.id, type: "task-status", status: plannerTask.status });
    }

    for (const subPrompt of subtasks) {
      // Stopping between subtasks: nothing is running to kill, so the loop itself has to notice.
      if (isCancelling(runId)) break;

      const task = newTask(subPrompt, "agent", null, agent);
      run.tasks.push(task);
      emit({ runId, taskId: task.id, type: "task-created", task });
      task.status = "running";
      emit({ runId, taskId: task.id, type: "task-status", status: "running" });

      const { ok, resultText, usage } = await runAgentProcess({
        runId,
        taskId: task.id,
        prompt: subPrompt,
        cwd: executionCwd,
        agent,
      });

      task.resultText = resultText;
      task.usage = usage;
      task.status = isCancelling(runId) ? "cancelled" : ok ? "done" : "error";
      emit({ runId, taskId: task.id, type: "task-status", status: task.status });
    }

    run.status = isCancelling(runId) ? "cancelled" : "done";
  } finally {
    cancelling.delete(runId);
    if (workspace) await finalizeRunReview(run, workspace);
  }
  emit({ runId, type: "run-status", status: run.status });
}

/** --------------------------- workflow run (graph: parallel branches + conditional routing) --------------------------- */

async function startWorkflowRun({ prompt, workflowId, cwd }) {
  const workflow = getWorkflow(workflowId);
  if (!workflow || !workflow.nodes.length) {
    throw new Error("Workflow không tồn tại hoặc không có bước nào");
  }
  const runId = nanoid(10);
  const run = {
    id: runId,
    prompt,
    agentId: null,
    workflowId: workflow.id,
    // Snapshot of the graph AS IT WAS when the run started. The run (and any later resume)
    // replays against this, not against the live workflow — editing a workflow shouldn't
    // silently rewrite a run that's already in flight, and the checkpoint below is keyed by
    // these node ids.
    workflowNodes: workflow.nodes,
    workflowEdges: workflow.edges,
    workflowIsolation: workflow.isolation,
    decompose: false,
    cwd: cwd || DEFAULT_CWD,
    status: "running",
    createdAt: Date.now(),
    tasks: [],
    checkpoint: emptyCheckpoint(),
  };
  runs.set(runId, run);
  emit({ runId, type: "run-created", run: summarize(run) });

  launchWorkflowRun(run);
  return runId;
}

/** --------------------------- checkpoint & resume --------------------------- */

/** Per-node progress, rebuilt into the in-memory graph state on resume. Lives on the run so it
 * rides along to runs.json with every other emit — i.e. it survives a crash, not just a stop. */
function emptyCheckpoint() {
  return { nodeStates: {}, outputs: {}, routerChoice: {} };
}

/** Rebuilds the workflow object a run executes against, from the run's own snapshot. */
function snapshotWorkflow(run) {
  return {
    id: run.workflowId,
    nodes: run.workflowNodes || [],
    edges: run.workflowEdges || [],
    isolation: run.workflowIsolation || { enabled: false, testCommand: "", keepOnFailure: true },
  };
}

function launchWorkflowRun(run) {
  process.nextTick(() =>
    executeWorkflowRun(run, snapshotWorkflow(run)).catch((err) => {
      run.status = "error";
      run.error = err.message;
      emit({ runId: run.id, type: "run-status", status: "error", error: err.message });
    })
  );
}

/**
 * A node is worth re-running unless it already finished cleanly. `error` counts as re-runnable
 * on purpose: that's usually the node the run died on, and "resume" is meant to pick up exactly
 * there. `skipped` is dropped back to pending too — the skip is re-derived from the edges and
 * the restored router choices anyway, so restoring it would just be a second source of truth.
 */
function checkpointStateFor(saved) {
  return saved === "done" ? "done" : "pending";
}

/** True when a stopped/crashed/failed workflow run still has nodes that never completed. */
function canResume(run) {
  if (!run || run.status === "running" || !run.workflowId) return false;
  if (["pending", "declined"].includes(run.review?.status)) return false;
  const nodes = (run.workflowNodes || []).filter((n) => n.autoStart !== false);
  if (!nodes.length) return false;
  const saved = run.checkpoint?.nodeStates || {};
  return nodes.some((n) => saved[n.id] !== "done");
}

/**
 * Re-runs a workflow run from its checkpoint: nodes that already finished keep their recorded
 * output and are not re-run, everything else starts over. Tasks from the interrupted attempt
 * stay in the history as-is and the new attempt appends its own, so the log shows both tries
 * rather than pretending the first one didn't happen.
 */
function resumeRun(runId) {
  const run = runs.get(runId);
  if (!run) return false;
  if (run.status === "running") throw new Error("Run này đang chạy — không cần resume.");
  if (!run.workflowId) {
    throw new Error("Chỉ run theo workflow mới resume được (run 1 agent không có checkpoint theo node).");
  }
  if (!canResume(run)) throw new Error("Run này đã chạy xong tất cả các bước — không còn gì để chạy tiếp.");

  cancelling.delete(runId);
  run.status = "running";
  run.error = null;
  run.resumedAt = Date.now();
  emit({ runId, type: "run-status", status: "running" });

  launchWorkflowRun(run);
  return true;
}

function nodeTitle(node) {
  const agent = getAgent(node.agentId);
  return `${node.kind === "router" ? "🔀 " : ""}${agent?.name || node.agentId}`;
}

/** Combine one or more upstream node outputs into the prompt for the next node.
 * With a single input this behaves like the old linear {{previous}}; with several
 * (a fan-in / merge node) each is labelled by source so the agent can tell them apart. */
function buildNodePrompt(template, originalPrompt, inputs) {
  const joined = inputs.map((i) => i.text).join("\n\n---\n\n");
  if (template && template.trim()) {
    return template.replaceAll("{{prompt}}", originalPrompt).replaceAll("{{previous}}", joined);
  }
  if (!inputs.length) return originalPrompt;
  if (inputs.length === 1) {
    return [
      `Yêu cầu gốc: ${originalPrompt}`,
      "",
      "Kết quả từ bước trước trong workflow:",
      inputs[0].text,
      "",
      "Hãy tiếp tục thực hiện bước tiếp theo dựa trên thông tin trên.",
    ].join("\n");
  }
  return [
    `Yêu cầu gốc: ${originalPrompt}`,
    "",
    `Dưới đây là kết quả từ ${inputs.length} nhánh trước đó — hãy tổng hợp / xử lý tiếp:`,
    "",
    ...inputs.map((i) => `### Kết quả từ "${i.title}"\n${i.text}`),
  ].join("\n\n");
}

/** A router node's result text picks exactly one outgoing edge, by matching the edge's
 * `condition` label (case-insensitive substring match) against the result. Falls back to
 * an edge with no condition ("else"/default), then to the first edge, so routing never stalls. */
function pickRoute(resultText, outgoingEdges) {
  if (!outgoingEdges.length) return null;
  const text = (resultText || "").toLowerCase();
  const matched = outgoingEdges.find((e) => e.condition && text.includes(e.condition.toLowerCase()));
  if (matched) return matched;
  const fallback = outgoingEdges.find((e) => !e.condition);
  return fallback || outgoingEdges[0];
}

/** Opens the git-worktree review session for a run (see server/workspace.js), plus the
 * "Workspace" task its setup/teardown logs go into.
 *
 * Returns `{ workspace, fatal }`. A null `workspace` splits two very different cases, and the
 * distinction comes from workspace.js rather than being guessed here:
 *   - `fatal: false` — the working directory just isn't a git repo. There is nothing to review
 *     against and nothing to protect, so the run goes ahead in `run.cwd` exactly as it did
 *     before review existed. Refusing here would mean the app couldn't touch a non-git folder
 *     at all.
 *   - `fatal: true`  — review should have applied and couldn't (dirty repo, git failure).
 *     Running anyway would edit files we can neither isolate nor roll back, so the caller stops.
 */
async function openRunWorkspace(run, workflow) {
  const task = newTask("🗂️ Workspace review (git worktree)", "workspace");
  run.tasks.push(task);
  emit({ runId: run.id, taskId: task.id, type: "task-created", task });
  task.status = "running";
  emit({ runId: run.id, taskId: task.id, type: "task-status", status: "running" });

  const log = (line) => pushTaskLog(run.id, task.id, line);
  const { session, fatal, reason } = await openWorkspaceSession({
    cwd: run.cwd,
    runId: run.id,
    isolation: workflow.isolation,
    log,
  });

  if (!session) {
    run.review = { status: "unavailable", reason };
    task.status = fatal ? "error" : "skipped";
    emit({ runId: run.id, taskId: task.id, type: "task-status", status: task.status });
    return { workspace: null, fatal };
  }
  log(
    `Review an toàn đang BẬT. Agent làm việc trên nhánh ${session.reviewBranch}; ` +
    `nhánh ${session.baseBranch} chỉ thay đổi sau khi bạn bấm Accept.`
  );
  return { workspace: { session, taskId: task.id, log }, fatal: false };
}

/**
 * Turns the review worktree into the run's reviewable diff and tears the session down.
 *
 * Runs from the callers' `finally`, so it must not throw: an exception raised here would replace
 * whatever actually killed the run with a git error, and skip the teardown besides. A failure to
 * produce the diff is therefore recorded as an `unavailable` review carrying its own reason.
 */
async function finalizeRunReview(run, workspace, keptDirs = []) {
  try {
    run.review = await finalizeWorkspaceReview(workspace.session, workspace.log);
    if (run.review.status === "pending") {
      workspace.log(
        keptDirs.length
          ? `🔎 Có ${run.review.files.length} file thay đổi đang chờ Accept hoặc Decline. Còn ${keptDirs.length} workspace lỗi được giữ lại để kiểm tra.`
          : `🔎 Có ${run.review.files.length} file thay đổi đang chờ Accept hoặc Decline.`
      );
    } else {
      workspace.log("ℹ️ Run không thay đổi file nào.");
    }
  } catch (err) {
    run.review = {
      status: "unavailable",
      reason: `Không dựng được bản review cho run này: ${err.message}. Nhánh ${workspace.session.reviewBranch} vẫn còn trong repo nếu bạn muốn tự xem.`,
    };
    workspace.log(`❌ ${run.review.reason}`);
  }

  try {
    await closeWorkspaceSession(workspace.session, keptDirs);
  } catch {
    /* teardown is best-effort; `git worktree prune` failing must not sink the run */
  }

  const wsTask = run.tasks.find((t) => t.id === workspace.taskId);
  if (wsTask?.status === "running") {
    wsTask.status = run.review.status === "unavailable" ? "error" : "done";
    emit({ runId: run.id, taskId: wsTask.id, type: "task-status", status: wsTask.status });
  }
  emit({ runId: run.id, type: "review-status", status: run.review.status });
}

/** Opens (and always closes) the review session around the actual graph walk. */
async function executeWorkflowRun(run, workflow) {
  const { workspace, fatal } = await openRunWorkspace(run, workflow);
  if (!workspace && fatal) {
    run.status = "error";
    run.error = run.review?.reason;
    cancelling.delete(run.id);
    emit({ runId: run.id, type: "run-status", status: "error", error: run.error });
    return;
  }
  // Worktrees deliberately left on disk (failed tests / merge conflicts) — closeWorkspaceSession
  // must not sweep the run's worktree root while any of these are still there.
  const keptDirs = [];
  try {
    await executeGraph(run, workflow, workspace, keptDirs);
  } finally {
    // The run is over one way or another; a later resume must not inherit the stop flag.
    cancelling.delete(run.id);
    if (workspace) await finalizeRunReview(run, workspace, keptDirs);
  }
}

async function executeGraph(run, workflow, workspace, keptDirs) {
  const { id: runId, prompt, cwd } = run;
  // Nodes with autoStart:false never run as part of the graph itself (not a root, and any
  // edge touching them is ignored here) — they only run when another node calls them via
  // ask_agent (askAgent() looks them up straight from workflow.nodes, independent of this).
  // That's how a caller node can fully own sequencing: call A, wait for it, then call B,
  // instead of the graph auto-fanning-out to both in parallel.
  const nodes = workflow.nodes.filter((n) => n.autoStart !== false);
  const nodeIdSet = new Set(nodes.map((n) => n.id));
  const edges = workflow.edges.filter((e) => nodeIdSet.has(e.from) && nodeIdSet.has(e.to));

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const incomingOf = new Map(nodes.map((n) => [n.id, edges.filter((e) => e.to === n.id)]));
  const outgoingOf = new Map(nodes.map((n) => [n.id, edges.filter((e) => e.from === n.id)]));

  // Seeded from the run's checkpoint, so a resumed run starts with everything that already
  // finished still marked done (with its output) instead of re-running the whole graph. On a
  // fresh run the checkpoint is empty and this collapses to the old all-pending start.
  const cp = (run.checkpoint ||= emptyCheckpoint());
  const state = new Map(nodes.map((n) => [n.id, checkpointStateFor(cp.nodeStates[n.id])])); // pending|running|done|error|skipped|cancelled
  const output = new Map(Object.entries(cp.outputs));
  const routerChoice = new Map(Object.entries(cp.routerChoice)); // routerNodeId -> chosen edge id
  const taskIdByNode = new Map();

  const resumedNodes = nodes.filter((n) => state.get(n.id) === "done");

  /** Mirrors a node's resolved state into the run's checkpoint. Called on every transition, so
   * whatever runs.json holds at any moment is enough to resume from. */
  const checkpointNode = (nodeId) => {
    cp.nodeStates[nodeId] = state.get(nodeId);
    if (output.has(nodeId)) cp.outputs[nodeId] = output.get(nodeId);
    if (routerChoice.has(nodeId)) cp.routerChoice[nodeId] = routerChoice.get(nodeId);
    scheduleSaveRuns();
  };

  const edgeSourceResolved = (e) => ["done", "error", "skipped", "cancelled"].includes(state.get(e.from));
  const edgeActive = (e) => {
    const src = nodeById.get(e.from);
    if (state.get(e.from) !== "done") return false;
    if (src.kind === "router") return routerChoice.get(e.from) === e.id;
    return true;
  };

  if (resumedNodes.length) {
    const task = newTask(
      `▶️ Chạy tiếp từ checkpoint — bỏ qua ${resumedNodes.length} bước đã xong: ${resumedNodes.map(nodeTitle).join(", ")}`,
      "resume"
    );
    task.status = "done";
    run.tasks.push(task);
    emit({ runId, taskId: task.id, type: "task-created", task });
  }

  let guard = 0;
  while (true) {
    // Checked before scheduling anything new: stopRun() kills whatever is running, but the
    // graph also has to stop handing out the work that hasn't started yet.
    if (isCancelling(runId)) {
      run.status = "cancelled";
      emit({ runId, type: "run-status", status: "cancelled" });
      return;
    }

    if (++guard > nodes.length * 4 + 20) {
      run.status = "error";
      emit({ runId, type: "run-status", status: "error", error: "Workflow graph không hợp lệ (có thể có vòng lặp)." });
      return;
    }

    // Resolve skips to a fixed point: a node whose incoming edges are all resolved but
    // none are active (e.g. every parent skipped, or a router sent flow elsewhere) is itself skipped.
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of nodes) {
        if (state.get(n.id) !== "pending") continue;
        const inc = incomingOf.get(n.id);
        if (!inc.length) continue; // root node — never auto-skipped
        if (!inc.every(edgeSourceResolved)) continue;
        if (!inc.some(edgeActive)) {
          state.set(n.id, "skipped");
          const task = newTask(nodeTitle(n), n.kind === "router" ? "workflow-router" : "workflow-node", n.id);
          task.status = "skipped";
          run.tasks.push(task);
          taskIdByNode.set(n.id, task.id);
          emit({ runId, taskId: task.id, type: "task-created", task });
          emit({ runId, taskId: task.id, type: "task-status", status: "skipped" });
          checkpointNode(n.id);
          changed = true;
        }
      }
    }

    const ready = nodes.filter((n) => {
      if (state.get(n.id) !== "pending") return false;
      const inc = incomingOf.get(n.id);
      if (!inc.length) return true;
      return inc.every(edgeSourceResolved) && inc.some(edgeActive);
    });

    if (!ready.length) {
      const stillPending = nodes.some((n) => state.get(n.id) === "pending");
      if (stillPending) {
        run.status = "error";
        emit({ runId, type: "run-status", status: "error", error: "Workflow graph không hợp lệ (bế tắc)." });
      } else {
        const anyError = nodes.some((n) => ["error", "cancelled"].includes(state.get(n.id)));
        run.status = anyError ? "error" : "done";
        emit({ runId, type: "run-status", status: run.status });
      }
      return;
    }

    for (const n of ready) state.set(n.id, "running");

    // Every node runs away from the checked-out branch. This makes the final diff reviewable
    // and declineable for linear workflows too, not only for parallel fan-out batches.
    const isolateBatch = !!workspace;

    // Created up-front, before any agent starts, so every branch of the fan-out begins from
    // the same HEAD — not from whatever an earlier sibling happened to have merged already.
    const batch = [];
    for (const n of ready) {
      const nodeAgent = getAgent(n.agentId);
      const task = newTask(nodeTitle(n), n.kind === "router" ? "workflow-router" : "workflow-node", n.id, nodeAgent);
      run.tasks.push(task);
      taskIdByNode.set(n.id, task.id);
      emit({ runId, taskId: task.id, type: "task-created", task });

      const wt = isolateBatch
        ? await createWorktree(workspace.session, n.id, (line) => pushTaskLog(runId, task.id, line))
        : null;
      batch.push({ node: n, task, agent: nodeAgent, wt, cwd: wt ? wt.dir : cwd });
    }

    await Promise.all(
      batch.map(async ({ node: n, task, agent, wt, cwd: nodeCwd }) => {
        if (workspace && !wt) {
          state.set(n.id, "error");
          task.status = "error";
          pushTaskLog(runId, task.id, "❌ Không tạo được workspace riêng; đã dừng để bảo vệ nhánh chính.");
          emit({ runId, taskId: task.id, type: "task-status", status: "error" });
          checkpointNode(n.id);
          return;
        }
        const inc = incomingOf.get(n.id).filter(edgeActive);
        const inputs = inc.map((e) => ({ title: nodeTitle(nodeById.get(e.from)), text: output.get(e.from) || "" }));
        const nodePrompt = buildNodePrompt(n.promptTemplate, prompt, inputs);

        task.status = "running";
        emit({ runId, taskId: task.id, type: "task-status", status: "running" });

        const { ok, resultText, usage } = await runAgentProcess({
          runId,
          taskId: task.id,
          prompt: nodePrompt,
          cwd: nodeCwd,
          agent,
          node: n,
          workflow,
        });

        task.resultText = resultText;
        task.usage = usage;
        output.set(n.id, resultText);

        if (!ok) {
          // A CLI that exited non-zero *because we killed it* isn't a failure to report as one
          // — it's the stop the user asked for, and it must not be checkpointed as a node that
          // was tried and failed, or resume would treat it as re-runnable for the wrong reason.
          const cancelled = isCancelling(runId);
          state.set(n.id, cancelled ? "cancelled" : "error");
          task.status = cancelled ? "cancelled" : "error";
          emit({ runId, taskId: task.id, type: "task-status", status: task.status });
          checkpointNode(n.id);
          return;
        }

        if (n.kind === "router") {
          const chosen = pickRoute(resultText, outgoingOf.get(n.id));
          if (chosen) {
            routerChoice.set(n.id, chosen.id);
            const chosenTarget = nodeById.get(chosen.to);
            pushTaskLog(
              runId,
              task.id,
              `🔀 Định tuyến tới: ${nodeTitle(chosenTarget)}${chosen.condition ? ` (điều kiện: "${chosen.condition}")` : ""}`
            );
          }
        }

        state.set(n.id, "done");
        task.status = "done";
        emit({ runId, taskId: task.id, type: "task-status", status: "done" });
        checkpointNode(n.id);
      })
    );

    // Commit → test → merge → clean up, ONE branch at a time: `git merge` takes the repo's
    // index lock, and each merge has to see the result of the previous one to detect a real
    // conflict between two siblings. A branch that fails its tests or conflicts flips its node
    // to "error" here, so downstream steps get skipped instead of building on work that never
    // actually landed on the base branch.
    //
    // On a stop, the branches are torn down instead: testing and merging work the user just
    // cancelled would be exactly the surprise they were trying to avoid. The worktrees are kept
    // or dropped by the same keepOnFailure setting, so whatever the agents did is still there
    // to look at.
    const stopping = isCancelling(runId);
    for (const { node: n, task, wt } of batch) {
      if (!wt) continue;
      const agentFailed = stopping || state.get(n.id) === "error";
      if (stopping) pushTaskLog(runId, task.id, "🛑 Run bị dừng — bỏ qua kiểm thử và gộp nhánh cho không gian riêng này.");
      const { ok } = await integrateWorktree(workspace.session, wt, {
        title: `${nodeTitle(n)} (${runId})`,
        agentFailed,
        log: (line) => pushTaskLog(runId, task.id, line),
      });
      if (!ok && workspace.session.keepOnFailure) keptDirs.push(wt.dir);
      if (!ok && !agentFailed) {
        state.set(n.id, "error");
        task.status = "error";
        emit({ runId, taskId: task.id, type: "task-status", status: "error" });
        checkpointNode(n.id);
      }
    }
  }
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export {
  MODELS,
  KNOWN_TOOLS,
  PROVIDERS,
  PROVIDER_AVAILABILITY,
  CODEX_SANDBOX_MODES,
  CODEX_MODELS,
  listAgents,
  getAgent,
  createAgent,
  updateAgent,
  deleteAgent,
  duplicateAgent,
  listWorkflows,
  getWorkflow,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  listSkills,
  getSkill,
  createSkill,
  updateSkill,
  deleteSkill,
  listPlugins,
  getPlugin,
  createPlugin,
  updatePlugin,
  deletePlugin,
  listRuns,
  getRun,
  getUsageSummary,
  acceptRunReview,
  declineRunReview,
  deleteRun,
  clearRuns,
  startRun,
  startWorkflowRun,
  stopRun,
  resumeRun,
  askAgent,
  subscribe,
  DEFAULT_CWD,
};
