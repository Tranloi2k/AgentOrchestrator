import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import spawn from "cross-spawn";
import { nanoid } from "nanoid";

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
 * Build an inline `--mcp-config` payload wiring the running node up to `mcp-bridge.js`,
 * which exposes one MCP tool (`ask_agent`) letting it call another node's agent
 * synchronously — send a question, block until that agent's full answer comes back, then
 * continue with it. This is scoped to a single workflow: `node` must belong to `workflow`
 * and only nodes listed in `node.calleeNodeIds` (configured in the workflow editor) are
 * reachable. Returns null outside a workflow run, when the node has no callees configured,
 * or the call chain is already at MAX_CALL_DEPTH (so a callee that also has callees can't
 * recurse forever).
 */
function buildAgentBridgeConfig(node, workflow, { runId, taskId, cwd, depth }) {
  if (!node?.calleeNodeIds?.length || !workflow || depth >= MAX_CALL_DEPTH) return null;
  const callable = node.calleeNodeIds
    .map((id) => workflow.nodes.find((n) => n.id === id))
    .filter(Boolean)
    .map((n) => ({ id: n.id, name: nodeTitle(n), description: getAgent(n.agentId)?.description || "" }));
  if (!callable.length) return null;

  const env = {
    AGENT_BRIDGE_URL: `http://localhost:${process.env.PORT || 5175}`,
    AGENT_BRIDGE_RUN_ID: runId || "",
    AGENT_BRIDGE_TASK_ID: taskId || "",
    AGENT_BRIDGE_WORKFLOW_ID: workflow.id || "",
    AGENT_BRIDGE_CALLER_NODE_ID: node.id || "",
    AGENT_BRIDGE_DEPTH: String(depth),
    AGENT_BRIDGE_CWD: cwd || "",
    AGENT_BRIDGE_CALLABLE: JSON.stringify(callable),
  };
  return JSON.stringify({ mcpServers: { "agent-bridge": { command: "node", args: [BRIDGE_SCRIPT], env } } });
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
        "Server đã dừng trong khi run này đang chạy dở — tiến trình bị ngắt. Log/kết quả đã có tới lúc đó vẫn được giữ nguyên.";
    }
    for (const t of r.tasks || []) {
      if (t.status === "running") t.status = "error";
    }
    runs.set(r.id, r);
  }
}
loadRuns();

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
  const run = runs.get(runId);
  const task = run?.tasks.find((t) => t.id === taskId);
  if (task) task.log.push(line);
  emit({ runId, taskId, type: "log", line });
}

function listRuns() {
  return [...runs.values()]
    .map(summarize)
    .sort((a, b) => b.createdAt - a.createdAt);
}

function summarize(run) {
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
    tasks: run.tasks.map((t) => ({
      id: t.id,
      nodeId: t.nodeId || null,
      title: t.title,
      kind: t.kind,
      status: t.status,
      log: t.log,
      resultText: t.resultText,
    })),
  };
}

function getRun(runId) {
  const run = runs.get(runId);
  return run ? summarize(run) : null;
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
    if (run.status === "running") {
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
 * `node`/`workflow`/`extraArgs`/`depth` (the two-way ask_agent bridge) only apply to the claude
 * provider today — codex has no equivalent wired up yet, see runCodexProcess's doc comment. */
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
    return Promise.resolve({ ok: false, resultText: "" });
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

    const bridgeConfig = buildAgentBridgeConfig(node, workflow, { runId, taskId, cwd, depth });
    // An empty allowedTools list normally means "no restriction" (no flag passed at all).
    // Once agent-bridge is wired in we must pass an explicit list so the new MCP tool is
    // allowed too — so an originally-unrestricted agent falls back to the same tool set our
    // own UI lets you toggle (KNOWN_TOOLS), plus ask_agent.
    let allowedTools = agent?.allowedTools?.length ? agent.allowedTools.slice() : bridgeConfig ? KNOWN_TOOLS.slice() : [];
    if (bridgeConfig) allowedTools.push(AGENT_BRIDGE_TOOL);
    if (allowedTools.length) args.push("--allowedTools", allowedTools.join(" "));
    if (agent?.disallowedTools?.length) args.push("--disallowedTools", agent.disallowedTools.join(" "));
    if (bridgeConfig) args.push("--mcp-config", bridgeConfig);

    const systemPrompt = buildSystemPrompt(agent);
    if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
    args.push(...buildPluginArgs(agent));

    const child = spawn("claude", args, { cwd });
    let buffer = "";
    let resultText = "";

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
          } else if (evt.type === "system") {
            pushLog(`ℹ️ ${evt.subtype || "system"}`);
          }
        } catch {
          pushLog(line);
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      pushLog(`⚠️ ${chunk.toString().trim()}`);
    });

    child.on("error", (err) => {
      pushLog(`❌ Lỗi khởi chạy claude CLI: ${err.message}`);
      resolve({ ok: false, resultText: "" });
    });

    child.on("close", (code) => {
      resolve({ ok: code === 0, resultText });
    });
  });
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
 * Not wired up: the two-way `ask_agent` bridge (Claude-only for now, via `--mcp-config`) and
 * per-tool allow/deny lists (`codex exec --help` doesn't expose an equivalent flag) — a codex
 * node's access is controlled only by `codexSandbox` below (no approval-prompt flag exists on
 * `codex exec`, only on the interactive `codex` command). Skills/private system-prompt still
 * apply: prepended to the prompt text itself, since codex has no `--append-system-prompt` flag.
 */
function runCodexProcess({ runId, taskId, prompt, cwd, agent }) {
  return new Promise((resolve) => {
    const outFile = path.join(tmpdir(), `codex-last-${taskId}.txt`);
    const systemPrompt = buildSystemPrompt(agent);
    const fullPrompt = systemPrompt ? `${systemPrompt}\n\n---\n\n${prompt}` : prompt;

    const args = [
      "exec",
      fullPrompt,
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

    // stdin must be closed, not just unwritten-to: `codex exec` checks whether stdin is a TTY
    // and if not (a bare pipe counts, even with nothing written) waits to read it and append
    // as a `<stdin>` block — with nothing ever written or closed that wait never ends. `ignore`
    // makes it look like there's no piped stdin at all, so codex proceeds immediately.
    const child = spawn("codex", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const pushLog = (line) => pushTaskLog(runId, taskId, line);
    let buffer = "";

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        try {
          const evt = JSON.parse(line);
          const text = extractCodexText(evt);
          pushLog(text ? `💬 ${text}` : `🔧 ${line.length > 300 ? line.slice(0, 300) + "…" : line}`);
        } catch {
          pushLog(line);
        }
      }
    });

    child.stderr.on("data", (chunk) => {
      pushLog(`⚠️ ${chunk.toString().trim()}`);
    });

    child.on("error", (err) => {
      pushLog(`❌ Lỗi khởi chạy codex CLI: ${err.message}`);
      try {
        rmSync(outFile, { force: true });
      } catch {
        /* ignore */
      }
      resolve({ ok: false, resultText: "" });
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
      resolve({ ok: code === 0, resultText });
    });
  });
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

function newTask(title, kind, nodeId = null) {
  return { id: nanoid(8), nodeId, title, kind, status: "pending", log: [], resultText: "" };
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
async function askAgent({ runId, workflowId, callerNodeId, targetNodeId, question, cwd, depth }) {
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

  const task = newTask(`💬 ${nodeTitle(callerNode)} hỏi ${nodeTitle(targetNode)}`, "agent-call", targetNode.id);
  run.tasks.push(task);
  emit({ runId, taskId: task.id, type: "task-created", task });
  task.status = "running";
  emit({ runId, taskId: task.id, type: "task-status", status: "running" });
  pushTaskLog(runId, task.id, `❓ ${question}`);

  const { ok, resultText } = await runAgentProcess({
    runId,
    taskId: task.id,
    prompt: question,
    cwd,
    agent: targetAgent,
    node: targetNode,
    workflow,
    depth: depth + 1,
  });

  task.resultText = resultText;
  task.status = ok ? "done" : "error";
  emit({ runId, taskId: task.id, type: "task-status", status: task.status });

  return resultText;
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
  const { id: runId, prompt, cwd, decompose } = run;

  let subtasks = [prompt];

  if (decompose) {
    const plannerTask = newTask("Planner: chia nhỏ yêu cầu", "planner");
    run.tasks.push(plannerTask);
    emit({ runId, taskId: plannerTask.id, type: "task-created", task: plannerTask });
    plannerTask.status = "running";
    emit({ runId, taskId: plannerTask.id, type: "task-status", status: "running" });

    subtasks = await decomposePrompt({ runId, taskId: plannerTask.id, prompt, cwd });

    plannerTask.status = "done";
    emit({ runId, taskId: plannerTask.id, type: "task-status", status: "done" });
  }

  for (const subPrompt of subtasks) {
    const task = newTask(subPrompt, "agent");
    run.tasks.push(task);
    emit({ runId, taskId: task.id, type: "task-created", task });
    task.status = "running";
    emit({ runId, taskId: task.id, type: "task-status", status: "running" });

    const { ok, resultText } = await runAgentProcess({
      runId,
      taskId: task.id,
      prompt: subPrompt,
      cwd,
      agent,
    });

    task.resultText = resultText;
    task.status = ok ? "done" : "error";
    emit({ runId, taskId: task.id, type: "task-status", status: task.status });
  }

  run.status = "done";
  emit({ runId, type: "run-status", status: "done" });
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
    workflowNodes: workflow.nodes,
    workflowEdges: workflow.edges,
    decompose: false,
    cwd: cwd || DEFAULT_CWD,
    status: "running",
    createdAt: Date.now(),
    tasks: [],
  };
  runs.set(runId, run);
  emit({ runId, type: "run-created", run: summarize(run) });

  process.nextTick(() =>
    executeWorkflowRun(run, workflow).catch((err) => {
      run.status = "error";
      run.error = err.message;
      emit({ runId, type: "run-status", status: "error", error: err.message });
    })
  );

  return runId;
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

async function executeWorkflowRun(run, workflow) {
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

  const state = new Map(nodes.map((n) => [n.id, "pending"])); // pending|running|done|error|skipped
  const output = new Map();
  const routerChoice = new Map(); // routerNodeId -> chosen edge id
  const taskIdByNode = new Map();

  const edgeSourceResolved = (e) => ["done", "error", "skipped"].includes(state.get(e.from));
  const edgeActive = (e) => {
    const src = nodeById.get(e.from);
    if (state.get(e.from) !== "done") return false;
    if (src.kind === "router") return routerChoice.get(e.from) === e.id;
    return true;
  };

  let guard = 0;
  while (true) {
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
        const anyError = nodes.some((n) => state.get(n.id) === "error");
        run.status = anyError ? "error" : "done";
        emit({ runId, type: "run-status", status: run.status });
      }
      return;
    }

    for (const n of ready) state.set(n.id, "running");

    await Promise.all(
      ready.map(async (n) => {
        const inc = incomingOf.get(n.id).filter(edgeActive);
        const inputs = inc.map((e) => ({ title: nodeTitle(nodeById.get(e.from)), text: output.get(e.from) || "" }));
        const nodePrompt = buildNodePrompt(n.promptTemplate, prompt, inputs);

        const task = newTask(nodeTitle(n), n.kind === "router" ? "workflow-router" : "workflow-node", n.id);
        run.tasks.push(task);
        taskIdByNode.set(n.id, task.id);
        emit({ runId, taskId: task.id, type: "task-created", task });
        task.status = "running";
        emit({ runId, taskId: task.id, type: "task-status", status: "running" });

        const agent = getAgent(n.agentId);
        const { ok, resultText } = await runAgentProcess({ runId, taskId: task.id, prompt: nodePrompt, cwd, agent, node: n, workflow });

        task.resultText = resultText;
        output.set(n.id, resultText);

        if (!ok) {
          state.set(n.id, "error");
          task.status = "error";
          emit({ runId, taskId: task.id, type: "task-status", status: "error" });
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
      })
    );
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
  deleteRun,
  clearRuns,
  startRun,
  startWorkflowRun,
  askAgent,
  subscribe,
  DEFAULT_CWD,
};
