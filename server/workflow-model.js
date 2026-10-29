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
import { normalizeSpawnPolicy } from "./spawn-policy.js";

export const WORKFLOW_TYPES = ["pipeline", "team"];
export const COORDINATOR_NODE_ID = "coordinator";
const ALIAS_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const ROUTE_LABEL_MAX = 40;

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
      agentId: String(m.agentId || ""),
      role: String(m.role || "").trim(),
    })),
    spawnPolicy: normalizeSpawnPolicy(team.spawnPolicy),
  };
}

/** The graph a team runs as. Members without an alias or agent are left out (validation reports them). */
export function teamToGraph(team) {
  const members = team.members.filter((m) => m.alias && m.agentId && m.alias !== COORDINATOR_NODE_ID);
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
      },
      ...members.map((m) => ({
        id: m.alias,
        agentId: m.agentId,
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
      // Manual canvas position (editor drag-and-drop); omitted -> client auto-places it.
      ...(typeof n.x === "number" && typeof n.y === "number" ? { x: n.x, y: n.y } : {}),
    }));
  const nodeIds = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    n.calleeNodeIds = n.calleeNodeIds.filter((id) => nodeIds.has(id) && id !== n.id);
  }

  const edges = (rawEdges || [])
    .filter((e) => e && nodeIds.has(e.from) && nodeIds.has(e.to) && e.from !== e.to)
    .map((e) => ({ id: String(e.id ?? nanoid(6)), from: String(e.from), to: String(e.to), condition: String(e.condition || "").trim() }));

  return { nodes, edges };
}

export function normalizeWorkflowInput(input) {
  const type = input.type === "team" ? "team" : "pipeline";
  const common = {
    name: String(input.name || "Unnamed workflow").slice(0, 80),
    description: String(input.description || ""),
    type,
    isolation: normalizeIsolationInput(input.isolation),
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
  if (input.type === "team") validateTeam(normalizeTeam(input.team), agentExists, err);
  else validatePipeline(input, agentExists, err);
  return errors;
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
    if (!m.agentId) err("memberNoAgent", { alias: who });
    else if (!agentExists(m.agentId)) err("unknownAgent", { node: who });
    if (!m.role) err("memberNoRole", { alias: who });
  });

  if (team.spawnPolicy.enabled && !team.spawnPolicy.providers.length) err("spawnNoProviders");
}

function validatePipeline(input, agentExists, err) {
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
  }

  const edges = [];
  const edgeKeys = new Set();
  for (const e of edgesIn) {
    const from = String(e.from ?? "");
    const to = String(e.to ?? "");
    if (!byId.has(from) || !byId.has(to)) err("edgeUnknownNode", { from, to });
    else if (from === to) err("edgeSelfLoop", { node: from });
    else if (edgeKeys.has(`${from}>${to}`)) err("edgeDuplicate", { from, to });
    else edges.push({ from, to, condition: String(e.condition || "").trim() });
    edgeKeys.add(`${from}>${to}`);
  }

  const isManual = (n) => n.autoStart === false;
  const calledBy = (id) => nodes.filter((n) => (n.calleeNodeIds || []).map(String).includes(id));

  for (const n of nodes) {
    const id = String(n.id ?? "");
    for (const c of (n.calleeNodeIds || []).map(String)) {
      if (c === id) err("calleeSelf", { node: id });
      else if (!byId.has(c)) err("calleeUnknown", { node: id, callee: c });
    }

    const incoming = edges.filter((e) => e.to === id);
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
    if (template.trim() && incoming.length && !template.includes("{{previous}}")) err("templateMissingPrevious", { node: id });
  }

  const autoNodes = nodes.filter((n) => !isManual(n));
  const autoIds = new Set(autoNodes.map((n) => String(n.id)));
  const autoEdges = edges.filter((e) => autoIds.has(e.from) && autoIds.has(e.to));
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
