/**
 * Workflow shape, save-time validation and router parsing — no I/O, so it can be unit-tested.
 *
 * Two kinds of workflow:
 *  - "pipeline": a node graph. Edges carry data forward and run branches in parallel; a router
 *    node picks one outgoing branch by label; a manual node (autoStart: false) only runs when
 *    another node hands it work through ask_agent.
 *  - "team": one coordinator agent plus named members (alias + role). The coordinator decides
 *    who does what through ask_agent and may spawn agents if the team allows it. Stored as
 *    `team`, and turned into an ordinary graph (teamToGraph) so the executor, run snapshots and
 *    the agent bridge don't need a second code path: the coordinator is the only node that runs
 *    on its own, and it may call every member; members are manual nodes whose id is their alias.
 */
import { nanoid } from "nanoid";
import { normalizeSpawnPolicy } from "../runs/spawn-policy.js";
import { parseCron } from "../schedules/cron.js";

export const WORKFLOW_TYPES = ["pipeline", "team"];
export const COORDINATOR_NODE_ID = "coordinator";
const ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ROUTE_LABEL_MAX = 40;
// Names usable in templates: {{nodes.<name>}} for a node's output, {{input.<name>}} for a run input.
export const REF_NAME_RE = /^[a-z][a-z0-9_-]{0,39}$/;
export const MAX_LOOP_ITERATIONS = 20;

const intIn = (v, min, max, fallback) => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** {{nodes.x}} and {{input.x}} references in a template. */
export function templateRefs(text) {
  const nodes = [...String(text || "").matchAll(/\{\{\s*nodes\.([\w-]+)\s*\}\}/g)].map((m) => m[1]);
  const inputs = [...String(text || "").matchAll(/\{\{\s*input\.([\w-]+)\s*\}\}/g)].map((m) => m[1]);
  return { nodes: [...new Set(nodes)], inputs: [...new Set(inputs)] };
}

/** Fills {{prompt}}, {{previous}}, {{nodes.x}} and {{input.x}} in a template. */
export function renderTemplate(template, { prompt = "", previous = "", nodes = {}, inputs = {} }) {
  return String(template)
    .replace(/\{\{\s*nodes\.([\w-]+)\s*\}\}/g, (_, name) => nodes[name] ?? "")
    .replace(/\{\{\s*input\.([\w-]+)\s*\}\}/g, (_, name) => inputs[name] ?? "")
    .replaceAll("{{prompt}}", prompt)
    .replaceAll("{{previous}}", previous);
}

/** Named run inputs a workflow asks for, e.g. topic → {{input.topic}}. */
function normalizeInputs(input) {
  return (Array.isArray(input) ? input : []).filter(Boolean).slice(0, 30).map((i) => ({
    name: String(i.name || "").trim().toLowerCase(),
    label: String(i.label || "").slice(0, 120),
    default: String(i.default ?? ""),
    required: !!i.required,
  }));
}

/** Limits for a whole run: wall-clock minutes and tokens (input + output + cache writes); 0 = none. */
function normalizeLimits(input) {
  return { timeoutMin: intIn(input?.timeoutMin, 0, 24 * 60, 0), tokenBudget: intIn(input?.tokenBudget, 0, 1e9, 0) };
}

/** Cron triggers: each starts a run of this workflow with its own request, inputs and folder. */
function normalizeSchedules(input) {
  return (Array.isArray(input) ? input : []).filter(Boolean).slice(0, 20).map((sc) => ({
    id: String(sc.id || nanoid(6)),
    enabled: sc.enabled !== false,
    cron: String(sc.cron || "").trim(),
    prompt: String(sc.prompt || ""),
    inputs: Object.fromEntries(Object.entries(sc.inputs && typeof sc.inputs === "object" ? sc.inputs : {}).map(([k, v]) => [String(k), String(v ?? "")])),
    cwd: String(sc.cwd || ""),
    targetBranch: String(sc.targetBranch || ""),
  }));
}

/** Values for a workflow's inputs: given values, else defaults. Throws listing missing required ones. */
export function resolveInputs(declared, given = {}) {
  const values = {};
  const missing = [];
  for (const i of declared || []) {
    const v = String(given?.[i.name] ?? "").trim() ? String(given[i.name]) : i.default;
    if (i.required && !String(v || "").trim()) missing.push(i.label || i.name);
    values[i.name] = v || "";
  }
  if (missing.length) throw new Error(`Thiếu giá trị đầu vào: ${missing.join(", ")}`);
  return values;
}

/** --------------------------- normalization (lenient: also used when loading old files) --------------------------- */

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

export const MAX_MEMBER_AGENTS = 6;

/**
 * A member's agents in the order the server tries them: the first is the primary, the rest take
 * over when it is out of quota or its CLI is missing (see team-calls.js). Teams saved with a
 * single `agentId` become a one-item list. Duplicates are kept here so validation can report them.
 */
function memberAgentIds(m) {
  const list = Array.isArray(m.agentIds) ? m.agentIds : m.agentId ? [m.agentId] : [];
  return list.map((id) => String(id || "")).filter(Boolean).slice(0, MAX_MEMBER_AGENTS);
}

/**
 * Limits for a whole Team run, enforced by the server on its members (team-calls.js):
 *  - maxDelegations:     ask_agent calls per run (a call answered from an earlier attempt doesn't count)
 *  - callTimeoutMinutes: wall-clock time one ask_agent call may take, failover included
 *  - runTokenBudget:     tokens (input + output + cache writes) for the whole run, coordinator,
 *                        members and spawned agents together; 0 = no limit
 */
export const DEFAULT_TEAM_LIMITS = { maxDelegations: 30, callTimeoutMinutes: 30, runTokenBudget: 2_000_000 };

export function normalizeTeamLimits(input) {
  return {
    maxDelegations: intIn(input?.maxDelegations, 1, 1000, DEFAULT_TEAM_LIMITS.maxDelegations),
    callTimeoutMinutes: intIn(input?.callTimeoutMinutes, 1, 24 * 60, DEFAULT_TEAM_LIMITS.callTimeoutMinutes),
    runTokenBudget: intIn(input?.runTokenBudget, 0, 1e9, DEFAULT_TEAM_LIMITS.runTokenBudget),
  };
}

export function normalizeTeam(input) {
  const team = input || {};
  return {
    coordinator: {
      agentId: String(team.coordinator?.agentId || ""),
      // How the coordinator should run the team. The member list and the workItemId rules are
      // put into the ask_agent tool description at run time, so this only describes the process.
      process: String(team.coordinator?.process || ""),
    },
    members: (Array.isArray(team.members) ? team.members : []).filter(Boolean).map((m) => ({
      alias: String(m.alias || "").trim().toLowerCase(),
      agentIds: memberAgentIds(m),
      role: String(m.role || "").trim(),
    })),
    spawnPolicy: normalizeSpawnPolicy(team.spawnPolicy),
    limits: normalizeTeamLimits(team.limits),
  };
}

/** The graph a team runs as. Members without an alias or agent are left out (validation reports them). */
export function teamToGraph(team) {
  const members = team.members
    .filter((m) => m.alias && m.agentIds.length && m.alias !== COORDINATOR_NODE_ID)
    .map((m) => ({ ...m, agentIds: [...new Set(m.agentIds)] }));
  return {
    nodes: [
      {
        id: COORDINATOR_NODE_ID,
        agentId: team.coordinator.agentId,
        promptTemplate: team.coordinator.process,
        kind: "agent",
        teamRole: "coordinator",
        calleeNodeIds: members.map((m) => m.alias),
        autoStart: true,
        // Overrides whatever spawn_agent setting the coordinator's agent has on its own.
        spawnPolicy: team.spawnPolicy,
        // Carried on the node so a run's snapshot keeps the limits it started with.
        teamLimits: team.limits,
      },
      ...members.map((m) => ({
        id: m.alias,
        // agentId is the primary, so everything that names a node by its agent keeps working.
        agentId: m.agentIds[0],
        agentIds: m.agentIds,
        promptTemplate: "",
        kind: "agent",
        teamRole: "member",
        alias: m.alias,
        role: m.role,
        calleeNodeIds: [],
        autoStart: false,
      })),
    ],
    edges: [],
  };
}

/**
 * Pipeline shape: { nodes: [{id, agentId, promptTemplate, kind, calleeNodeIds, autoStart}], edges: [{id, from, to, condition}] }
 * kind: "agent" | "router" (a router's answer picks exactly one outgoing edge by its label, `condition`).
 *
 * Back-compat: legacy `{ steps: [{agentId, promptTemplate}] }` (strict linear chain) is migrated
 * into the equivalent graph. Dangling references are dropped here so an old file still loads;
 * saving through the API runs validateWorkflow first, which reports them instead.
 */
function normalizePipeline(input) {
  let rawNodes = Array.isArray(input.nodes) ? input.nodes : null;
  let rawEdges = Array.isArray(input.edges) ? input.edges : null;

  if (!rawNodes && Array.isArray(input.steps)) {
    const steps = input.steps.filter((s) => s && s.agentId);
    rawNodes = steps.map((s, i) => ({ id: `n${i}`, agentId: s.agentId, promptTemplate: s.promptTemplate || "", kind: "agent" }));
    rawEdges = rawNodes.slice(0, -1).map((n, i) => ({ from: n.id, to: rawNodes[i + 1].id }));
  }

  const nodes = (rawNodes || [])
    .filter((n) => n && n.agentId)
    .map((n) => ({
      id: String(n.id ?? nanoid(6)),
      agentId: String(n.agentId),
      promptTemplate: String(n.promptTemplate || ""),
      kind: n.kind === "router" ? "router" : "agent",
      // Nodes this node may hand work to mid-run through ask_agent (and wait for the answer).
      calleeNodeIds: Array.isArray(n.calleeNodeIds) ? n.calleeNodeIds.map(String) : [],
      // false = never runs on its own as part of the graph; only when another node calls it.
      autoStart: n.autoStart !== false,
      // Name for {{nodes.<name>}} in later nodes' prompts; empty = not referable.
      name: String(n.name || "").trim().toLowerCase(),
      // Reliability: tried in order after the node's own agent when it fails on quota or an
      // unavailable CLI; `retries` re-runs the same agent on any other failure or a timeout.
      fallbackAgentIds: [...new Set((Array.isArray(n.fallbackAgentIds) ? n.fallbackAgentIds : []).map(String))].filter((id) => id && id !== String(n.agentId)).slice(0, 5),
      retries: intIn(n.retries, 0, 5, 0),
      retryDelaySec: intIn(n.retryDelaySec, 0, 600, 10),
      // Per attempt, seconds; 0 = no limit. Tokens are for the node across attempts and loop rounds.
      timeoutSec: intIn(n.timeoutSec, 0, 24 * 3600, 0),
      tokenBudget: intIn(n.tokenBudget, 0, 1e9, 0),
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
      condition: String(e.condition || "").trim(),
      // A loop edge goes back to an earlier node and re-runs everything in between, at most
      // maxIterations times — the only way a pipeline may cycle.
      ...(e.loop ? { loop: true, maxIterations: intIn(e.maxIterations, 1, MAX_LOOP_ITERATIONS, 3) } : {}),
    }));

  return { nodes, edges };
}

export function normalizeWorkflowInput(input) {
  const type = input.type === "team" ? "team" : "pipeline";
  const common = {
    name: String(input.name || "Unnamed workflow").slice(0, 80),
    description: String(input.description || ""),
    type,
    isolation: normalizeIsolationInput(input.isolation),
    inputs: normalizeInputs(input.inputs),
    limits: normalizeLimits(input.limits),
    schedules: normalizeSchedules(input.schedules),
  };
  if (type === "team") {
    const team = normalizeTeam(input.team);
    return { ...common, team, ...teamToGraph(team) };
  }
  return { ...common, ...normalizePipeline(input) };
}

/** --------------------------- validation (strict: runs on every save) --------------------------- */

/**
 * Returns a list of problems as `{ code, params }` (empty = valid) instead of quietly dropping
 * whatever doesn't fit. The client turns each code into a message; params carry node ids,
 * aliases and labels so the message can point at the exact spot.
 */
export function validateWorkflow(input, { agentExists }) {
  const errors = [];
  const err = (code, params = {}) => errors.push({ code, params });
  const inputs = normalizeInputs(input.inputs);
  validateInputsAndSchedules(inputs, normalizeSchedules(input.schedules), err);
  const inputNames = new Set(inputs.map((i) => i.name));
  if (input.type === "team") {
    const team = normalizeTeam(input.team);
    validateTeam(team, agentExists, err);
    for (const ref of templateRefs(team.coordinator.process).inputs) if (!inputNames.has(ref)) err("refUnknownInput", { node: COORDINATOR_NODE_ID, ref });
  } else validatePipeline(input, agentExists, err, inputNames);
  return errors;
}

function validateInputsAndSchedules(inputs, schedules, err) {
  const seen = new Set();
  for (const i of inputs) {
    if (!REF_NAME_RE.test(i.name)) err("inputNameInvalid", { name: i.name });
    else if (seen.has(i.name)) err("inputNameDuplicate", { name: i.name });
    seen.add(i.name);
  }
  schedules.forEach((sc, index) => {
    const n = index + 1;
    try {
      parseCron(sc.cron);
    } catch (e) {
      err("scheduleCronInvalid", { index: n, cron: sc.cron, reason: e.message });
    }
    if (!sc.prompt.trim()) err("scheduleNoPrompt", { index: n });
    for (const i of inputs) {
      if (i.required && !String(sc.inputs[i.name] ?? i.default ?? "").trim()) err("scheduleMissingInput", { index: n, name: i.label || i.name });
    }
  });
}

function validateTeam(team, agentExists, err) {
  if (!team.coordinator.agentId) err("teamNoCoordinator");
  else if (!agentExists(team.coordinator.agentId)) err("unknownAgent", { node: COORDINATOR_NODE_ID });

  // A team without members is fine as long as its coordinator can spawn agents — that is how a
  // run gets a supervisor creating agents on the fly. With neither, it has nobody to hand work to.
  if (!team.members.length && !team.spawnPolicy.enabled) err("teamEmpty");
  const seen = new Set();
  team.members.forEach((m, i) => {
    const alias = m.alias;
    if (!ALIAS_RE.test(alias)) err("memberAliasInvalid", { alias, index: i + 1 });
    else if (alias === COORDINATOR_NODE_ID) err("memberAliasReserved", { alias });
    else if (seen.has(alias)) err("memberAliasDuplicate", { alias });
    seen.add(alias);
    const who = alias || `#${i + 1}`;
    if (!m.agentIds.length) err("memberNoAgent", { alias: who });
    if (m.agentIds.some((id) => !agentExists(id))) err("unknownAgent", { node: who });
    if (new Set(m.agentIds).size !== m.agentIds.length) err("memberAgentDuplicate", { alias: who });
    if (!m.role) err("memberNoRole", { alias: who });
  });

  if (team.spawnPolicy.enabled && !team.spawnPolicy.providers.length) err("spawnNoProviders");
}

function validatePipeline(input, agentExists, err, inputNames = new Set()) {
  const nodes = (Array.isArray(input.nodes) ? input.nodes : []).filter(Boolean);
  const edgesIn = (Array.isArray(input.edges) ? input.edges : []).filter(Boolean);
  if (!nodes.length) {
    err("noNodes");
    return;
  }

  const byId = new Map();
  for (const n of nodes) {
    const id = String(n.id ?? "");
    if (byId.has(id)) err("duplicateNodeId", { node: id });
    byId.set(id, n);
    if (!n.agentId) err("nodeNoAgent", { node: id });
    else if (!agentExists(n.agentId)) err("unknownAgent", { node: id });
    for (const fb of Array.isArray(n.fallbackAgentIds) ? n.fallbackAgentIds : []) if (!agentExists(fb)) err("unknownFallbackAgent", { node: id });
  }

  const names = new Map();
  for (const n of nodes) {
    const name = String(n.name || "").trim().toLowerCase();
    if (!name) continue;
    if (!REF_NAME_RE.test(name)) err("nodeNameInvalid", { node: String(n.id), name });
    else if (names.has(name)) err("nodeNameDuplicate", { name });
    names.set(name, String(n.id));
  }

  const edges = [];
  const edgeKeys = new Set();
  for (const e of edgesIn) {
    const from = String(e.from ?? "");
    const to = String(e.to ?? "");
    if (!byId.has(from) || !byId.has(to)) err("edgeUnknownNode", { from, to });
    else if (from === to) err("edgeSelfLoop", { node: from });
    else if (edgeKeys.has(`${from}>${to}`)) err("edgeDuplicate", { from, to });
    else edges.push({ from, to, condition: String(e.condition || "").trim(), loop: !!e.loop });
    edgeKeys.add(`${from}>${to}`);
  }

  // Nodes every path into `id` can come from, following forward (non-loop) edges only.
  const ancestorsOf = (id) => {
    const seen = new Set();
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      for (const e of edges) if (!e.loop && e.to === cur && !seen.has(e.from)) {
        seen.add(e.from);
        stack.push(e.from);
      }
    }
    return seen;
  };

  const isManual = (n) => n.autoStart === false;
  const calledBy = (id) => nodes.filter((n) => (n.calleeNodeIds || []).map(String).includes(id));

  for (const n of nodes) {
    const id = String(n.id ?? "");
    for (const c of (n.calleeNodeIds || []).map(String)) {
      if (c === id) err("calleeSelf", { node: id });
      else if (!byId.has(c)) err("calleeUnknown", { node: id, callee: c });
    }

    // Loop edges don't feed a node on its first round, so they don't count as its input here.
    const incoming = edges.filter((e) => e.to === id && !e.loop);
    const outgoing = edges.filter((e) => e.from === id);

    if (isManual(n)) {
      if (incoming.length || outgoing.length) err("manualHasEdges", { node: id });
      if (!calledBy(id).length) err("manualNotCalled", { node: id });
    }

    if (n.kind === "router") {
      if (!outgoing.length) err("routerNoBranches", { node: id });
      const labels = new Set();
      for (const e of outgoing) {
        if (!e.condition) err("routerMissingLabel", { node: id, target: e.to });
        else if (e.condition.length > ROUTE_LABEL_MAX || /[\r\n,]/.test(e.condition)) err("routerLabelInvalid", { node: id, label: e.condition });
        else if (labels.has(e.condition.toLowerCase())) err("routerDuplicateLabel", { node: id, label: e.condition });
        labels.add(e.condition.toLowerCase());
      }
    } else {
      for (const e of outgoing) if (e.condition) err("conditionOnNonRouter", { node: id, target: e.to });
    }

    const template = String(n.promptTemplate || "");
    const refs = templateRefs(template);
    if (template.trim() && incoming.length && !template.includes("{{previous}}") && !refs.nodes.length) err("templateMissingPrevious", { node: id });
    for (const ref of refs.inputs) if (!inputNames.has(ref)) err("refUnknownInput", { node: id, ref });
    for (const ref of refs.nodes) {
      const target = names.get(ref);
      if (!target) err("refUnknownNode", { node: id, ref });
      else if (target === id || !ancestorsOf(id).has(target)) err("refNotUpstream", { node: id, ref });
    }
  }

  const autoNodes = nodes.filter((n) => !isManual(n));
  const autoIds = new Set(autoNodes.map((n) => String(n.id)));
  const autoEdges = edges.filter((e) => autoIds.has(e.from) && autoIds.has(e.to) && !e.loop);
  for (const e of edges.filter((x) => x.loop)) {
    if (!ancestorsOf(e.from).has(e.to)) err("loopNotBack", { from: e.from, to: e.to });
  }
  if (autoNodes.length && !autoNodes.some((n) => !autoEdges.some((e) => e.to === String(n.id)))) err("noRoot");
  const cycle = findCycle([...autoIds], autoEdges);
  if (cycle) err("cycle", { nodes: cycle });
  if (!autoNodes.length) err("noAutoNode");
}

/** Returns the node ids of one cycle (first node repeated at the end), or null. */
function findCycle(ids, edges) {
  const state = new Map(); // undefined = unvisited, 1 = on stack, 2 = done
  const stack = [];
  const visit = (id) => {
    state.set(id, 1);
    stack.push(id);
    for (const e of edges.filter((x) => x.from === id)) {
      if (state.get(e.to) === 1) return [...stack.slice(stack.indexOf(e.to)), e.to];
      if (!state.has(e.to)) {
        const found = visit(e.to);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };
  for (const id of ids) {
    if (!state.has(id)) {
      const found = visit(id);
      if (found) return found;
    }
  }
  return null;
}

/** --------------------------- router --------------------------- */

/** Appended to a router node's prompt: the answer must end with one exact `ROUTE: <label>` line. */
export function routeInstruction(outgoingEdges) {
  const labels = outgoingEdges.map((e) => e.condition.trim()).filter(Boolean);
  return [
    "",
    "---",
    "Đây là bước định tuyến. Dòng CUỐI CÙNG trong câu trả lời phải có đúng dạng:",
    "ROUTE: <nhãn>",
    `với <nhãn> là MỘT trong: ${labels.join(", ")}`,
  ].join("\n");
}

/**
 * Picks the branch from the last `ROUTE: <label>` line of a router's answer. The label must equal
 * an edge's label (case-insensitive, surrounding markdown like **bold** ignored) — no substring
 * matching, and no fallback: `edge` is null when the line is missing or names no branch, and the
 * caller fails the node rather than guess.
 */
export function pickRoute(resultText, outgoingEdges) {
  const matches = [...String(resultText || "").matchAll(/^[ \t>*_`]*ROUTE[ \t]*:[ \t]*(.*?)[ \t*_`.]*$/gim)];
  if (!matches.length) return { edge: null, label: null };
  const label = matches[matches.length - 1][1].trim();
  const edge = outgoingEdges.find((e) => e.condition.trim().toLowerCase() === label.toLowerCase()) || null;
  return { edge, label };
}
