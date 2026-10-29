/**
 * Agents: CRUD plus persistence to agents.config.json. Loaded once at startup and kept in memory.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { normalizeAccess } from "./access.js";
import { listWorkflows } from "../workflows/workflows.store.js";
import { SERVER_DIR, PROVIDERS, KNOWN_TOOLS, SUBAGENT_TOOL, loadJson } from "../../core/config.js";

const AGENTS_FILE = path.join(SERVER_DIR, "agents.config.json");

// Agents are re-normalized on load too — e.g. drops the now-removed legacy
// `calleeAgentIds` field (two-way agent calls now live per-node inside a workflow instead).
let AGENTS = loadJson(AGENTS_FILE, []).map((a) => ({ id: String(a.id || nanoid(8)), ...normalizeAgentInput(a) }));
saveAgents();

function saveAgents() {
  writeFileSync(AGENTS_FILE, JSON.stringify(AGENTS, null, 2), "utf-8");
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
  const usedByWorkflows = listWorkflows()
    .filter((w) => w.nodes.some((n) => n.agentId === id || n.agentIds?.includes(id)))
    .map((w) => w.name);
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

/** A deleted plugin is detached from every agent that used it. */
function removePluginFromAgents(pluginId) {
  let touched = false;
  for (const a of AGENTS) {
    if (a.pluginIds?.includes(pluginId)) {
      a.pluginIds = a.pluginIds.filter((pid) => pid !== pluginId);
      touched = true;
    }
  }
  if (touched) saveAgents();
}

export { listAgents, getAgent, createAgent, updateAgent, duplicateAgent, deleteAgent, removePluginFromAgents };
