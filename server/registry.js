/**
 * Agent / workflow / skill / plugin registry: CRUD plus persistence to the *.config.json files
 * next to this module. Everything here is loaded once at startup and kept in memory.
 */
import { writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { nanoid } from "nanoid";
import { normalizeAccess } from "./access.js";
import { normalizeWorkflowInput, validateWorkflow } from "./workflow-model.js";
import { SERVER_DIR, PROVIDERS, KNOWN_TOOLS, SUBAGENT_TOOL, loadJson } from "./config.js";

const AGENTS_FILE = path.join(SERVER_DIR, "agents.config.json");
const WORKFLOWS_FILE = path.join(SERVER_DIR, "workflows.config.json");
const SKILLS_FILE = path.join(SERVER_DIR, "skills.config.json");
const PLUGINS_FILE = path.join(SERVER_DIR, "plugins.config.json");
const PLUGINS_DIR = path.join(SERVER_DIR, "plugins");

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

/**
 * Claude tool access is an allowlist: a tool the agent doesn't list is blocked (passed as
 * --disallowedTools), not left to the permission mode. `disallowedTools` is therefore always
 * derived — every known tool that isn't allowed.
 *
 * Agents saved before this (no `toolPolicy`): a non-empty allow list already said exactly which
 * tools were meant, so it's kept (minus anything also denied). An empty list meant "no
 * restriction", so it becomes "everything except what was denied" — except the sub-agent tool,
 * which also injects delegation guidance into the prompt and was always an explicit opt-in.
 */
function normalizeToolAccess(input) {
  const pick = (v) => (Array.isArray(v) ? v.filter((t) => KNOWN_TOOLS.includes(t)) : []);
  let allowed = pick(input.allowedTools);
  if (input.toolPolicy !== "allowlist") {
    const denied = pick(input.disallowedTools);
    allowed = allowed.length
      ? allowed.filter((t) => !denied.includes(t))
      : KNOWN_TOOLS.filter((t) => !denied.includes(t) && t !== SUBAGENT_TOOL);
  }
  allowed = KNOWN_TOOLS.filter((t) => allowed.includes(t)); // dedupe, stable order
  return { toolPolicy: "allowlist", allowedTools: allowed, disallowedTools: KNOWN_TOOLS.filter((t) => !allowed.includes(t)) };
}

/**
 * An agent says what it may do on its own: `accessLevel` plus, for Claude, its tool allowlist.
 * The provider fields (permissionMode / codexSandbox / agyMode) are derived from the level and
 * can only be lowered — see access.js. Whom it may hand work to or spawn is not an agent setting;
 * that lives on the workflow. Legacy fields (readOnly, geminiApprovalMode, spawnPolicy) are read
 * once for migration and then dropped.
 */
function normalizeAgentInput(input) {
  const provider = PROVIDERS.includes(input.provider) ? input.provider : "claude";
  return {
    name: String(input.name || "Unnamed agent").slice(0, 80),
    description: String(input.description || ""),
    provider,
    model: String(input.model || ""),
    ...normalizeAccess({ ...input, provider }),
    ...normalizeToolAccess(input),
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

/** Thrown by createWorkflow/updateWorkflow; `errors` is the list from validateWorkflow. */
class WorkflowValidationError extends Error {
  constructor(errors) {
    super("Workflow không hợp lệ");
    this.errors = errors;
  }
}

function checkWorkflow(input) {
  const errors = validateWorkflow(input, { agentExists: (id) => AGENTS.some((a) => a.id === id) });
  if (errors.length) throw new WorkflowValidationError(errors);
}

function createWorkflow(input) {
  checkWorkflow(input);
  const workflow = { id: nanoid(8), ...normalizeWorkflowInput(input) };
  WORKFLOWS.push(workflow);
  saveWorkflows();
  return workflow;
}

/** The type is picked when the workflow is created and can't change afterwards. */
function updateWorkflow(id, input) {
  const idx = WORKFLOWS.findIndex((w) => w.id === id);
  if (idx === -1) return null;
  const merged = { ...WORKFLOWS[idx], ...input, type: WORKFLOWS[idx].type };
  checkWorkflow(merged);
  WORKFLOWS[idx] = { id, ...normalizeWorkflowInput(merged) };
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

/** How a node is named in logs and to other agents: a team member by its alias, the team's
 * coordinator and pipeline nodes by their agent's name. */
function nodeTitle(node) {
  const agentName = getAgent(node.agentId)?.name || node.agentId;
  if (node.alias) return `${node.alias} (${agentName})`;
  if (node.teamRole === "coordinator") return `🧭 ${agentName}`;
  return `${node.kind === "router" ? "🔀 " : ""}${agentName}`;
}

export {
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
  nodeTitle,
  WorkflowValidationError,
};
