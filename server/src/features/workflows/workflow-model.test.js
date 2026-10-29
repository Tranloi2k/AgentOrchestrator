import test from "node:test";
import assert from "node:assert/strict";
import { normalizeWorkflowInput, validateWorkflow, pickRoute, routeInstruction, COORDINATOR_NODE_ID } from "./workflow-model.js";

const agentExists = (id) => ["a1", "a2", "a3"].includes(id);
const codes = (input) => validateWorkflow(input, { agentExists }).map((e) => e.code);
const node = (id, extra = {}) => ({ id, agentId: "a1", promptTemplate: "", kind: "agent", calleeNodeIds: [], autoStart: true, ...extra });
const edge = (from, to, condition = "") => ({ id: `${from}-${to}`, from, to, condition });

test("a valid pipeline has no errors", () => {
  const wf = {
    nodes: [node("r", { kind: "router" }), node("bug"), node("ok", { promptTemplate: "Fix: {{previous}}" })],
    edges: [edge("r", "bug", "bug"), edge("r", "ok", "ok")],
  };
  assert.deepEqual(codes(wf), []);
});

test("pipeline problems are reported, not silently dropped", () => {
  assert.deepEqual(codes({ nodes: [] }), ["noNodes"]);
  assert.ok(codes({ nodes: [node("a", { agentId: "" })] }).includes("nodeNoAgent"));
  assert.ok(codes({ nodes: [node("a", { agentId: "gone" })] }).includes("unknownAgent"));
  assert.ok(codes({ nodes: [node("a")], edges: [edge("a", "zzz")] }).includes("edgeUnknownNode"));

  // manual node nobody calls, and a manual node wired with edges
  const manual = codes({ nodes: [node("a"), node("m", { autoStart: false })], edges: [edge("a", "m")] });
  assert.ok(manual.includes("manualNotCalled"));
  assert.ok(manual.includes("manualHasEdges"));

  // router branch without a label, duplicate labels, and a label on a non-router edge
  const router = codes({
    nodes: [node("r", { kind: "router" }), node("x"), node("y"), node("z"), node("p"), node("q")],
    edges: [edge("r", "x", ""), edge("r", "y", "Bug"), edge("r", "z", "bug"), edge("p", "q", "oops")],
  });
  assert.ok(router.includes("routerMissingLabel"));
  assert.ok(router.includes("routerDuplicateLabel"));
  assert.ok(router.includes("conditionOnNonRouter"));
  assert.ok(codes({ nodes: [node("r", { kind: "router" })] }).includes("routerNoBranches"));

  // cycle
  const cyc = validateWorkflow({ nodes: [node("s"), node("a"), node("b")], edges: [edge("s", "a"), edge("a", "b"), edge("b", "a")] }, { agentExists });
  assert.deepEqual(cyc.find((e) => e.code === "cycle")?.params.nodes, ["a", "b", "a"]);

  // template that ignores its input
  assert.ok(codes({ nodes: [node("a"), node("b", { promptTemplate: "Review the code" })], edges: [edge("a", "b")] }).includes("templateMissingPrevious"));
  assert.ok(!codes({ nodes: [node("a", { promptTemplate: "Start: {{prompt}}" })] }).includes("templateMissingPrevious"), "a root node has no input");
});

test("team: coordinator calls every member, members are manual nodes keyed by alias", () => {
  const wf = normalizeWorkflowInput({
    type: "team",
    team: {
      coordinator: { agentId: "a1", process: "Plan, build, review." },
      members: [
        { alias: "FE-Main", agentId: "a2", role: "Frontend" },
        { alias: "reviewer", agentId: "a3", role: "Review" },
      ],
      spawnPolicy: { enabled: true, providers: ["claude"] },
    },
  });
  assert.equal(wf.type, "team");
  const [coord, ...members] = wf.nodes;
  assert.equal(coord.id, COORDINATOR_NODE_ID);
  assert.deepEqual(coord.calleeNodeIds, ["fe-main", "reviewer"]);
  assert.equal(coord.spawnPolicy.enabled, true);
  assert.deepEqual(members.map((m) => [m.id, m.autoStart, m.calleeNodeIds.length, m.role]), [
    ["fe-main", false, 0, "Frontend"],
    ["reviewer", false, 0, "Review"],
  ]);
  assert.deepEqual(wf.edges, []);
});

test("team validation", () => {
  assert.deepEqual(
    codes({ type: "team", team: { coordinator: { agentId: "a1" }, members: [{ alias: "fe", agentId: "a2", role: "x" }] } }),
    []
  );
  const bad = codes({
    type: "team",
    team: {
      coordinator: { agentId: "" },
      members: [
        { alias: "fe main", agentId: "a2", role: "x" },
        { alias: "dup", agentId: "a2", role: "x" },
        { alias: "dup", agentId: "", role: "" },
        { alias: "coordinator", agentId: "a2", role: "x" },
      ],
      spawnPolicy: { enabled: true, providers: [] },
    },
  });
  for (const c of ["teamNoCoordinator", "memberAliasInvalid", "memberAliasDuplicate", "memberNoAgent", "memberNoRole", "memberAliasReserved", "spawnNoProviders"]) {
    assert.ok(bad.includes(c), c);
  }
  assert.ok(codes({ type: "team", team: { coordinator: { agentId: "a1" }, members: [] } }).includes("teamEmpty"));
  assert.deepEqual(
    codes({ type: "team", team: { coordinator: { agentId: "a1" }, members: [], spawnPolicy: { enabled: true, providers: ["claude"] } } }),
    [],
    "a coordinator that only spawns needs no members"
  );
});

test("router picks by the exact ROUTE label only", () => {
  const out = [edge("r", "x", "bug"), edge("r", "y", "ok")];
  assert.equal(pickRoute("Found a bug.\nROUTE: bug", out).edge.to, "x");
  assert.equal(pickRoute("**ROUTE: OK**", out).edge.to, "y", "case and markdown ignored");
  assert.equal(pickRoute("ROUTE: bug\nwait, actually\nROUTE: ok", out).edge.to, "y", "last ROUTE line wins");
  assert.deepEqual(pickRoute("this is not a bug, it is ok", out), { edge: null, label: null }, "no substring matching");
  assert.deepEqual(pickRoute("ROUTE: bugfix", out), { edge: null, label: "bugfix" });
  assert.match(routeInstruction(out), /ROUTE: <nhãn>[\s\S]*bug, ok/);
});

test("{{nodes.x}} must name an upstream node; {{input.x}} a declared input", () => {
  const base = {
    inputs: [{ name: "topic", required: true }],
    nodes: [node("a", { name: "researcher" }), node("b", { name: "writer", promptTemplate: "Write about {{input.topic}} using {{nodes.researcher}}" }), node("c")],
    edges: [edge("a", "b"), edge("b", "c")],
  };
  assert.deepEqual(codes(base), [], "refs replace {{previous}}");
  const bad = codes({
    ...base,
    nodes: [node("a", { name: "researcher", promptTemplate: "{{nodes.writer}} {{input.nope}}" }), node("b", { name: "writer", promptTemplate: "{{nodes.ghost}}" }), node("c", { name: "Bad Name" })],
  });
  for (const c of ["refNotUpstream", "refUnknownInput", "refUnknownNode", "nodeNameInvalid"]) assert.ok(bad.includes(c), c);
});

test("a loop edge must point back to an upstream node; it isn't a cycle error", () => {
  const loop = {
    nodes: [node("eng"), node("rev", { kind: "router", promptTemplate: "" })],
    edges: [edge("eng", "rev"), { ...edge("rev", "eng", "fix"), loop: true, maxIterations: 3 }],
  };
  assert.deepEqual(codes(loop), []);
  const normalized = normalizeWorkflowInput(loop);
  assert.equal(normalized.edges[1].maxIterations, 3);
  assert.ok(codes({ ...loop, edges: [edge("eng", "rev"), edge("rev", "eng", "fix")] }).includes("cycle"), "without loop:true it's still a cycle");
  assert.ok(codes({ nodes: [node("x"), node("y")], edges: [{ ...edge("x", "y"), loop: true }] }).includes("loopNotBack"));
});

test("reliability fields are clamped; fallback agents must exist and differ from the node's own", () => {
  const wf = normalizeWorkflowInput({
    nodes: [node("a", { agentId: "a1", fallbackAgentIds: ["a1", "a2", "a2"], retries: 99, timeoutSec: -5, tokenBudget: 1000 })],
  });
  const n = wf.nodes[0];
  assert.deepEqual([n.fallbackAgentIds, n.retries, n.timeoutSec, n.tokenBudget], [["a2"], 5, 0, 1000]);
  assert.ok(codes({ nodes: [node("a", { fallbackAgentIds: ["gone"] })] }).includes("unknownFallbackAgent"));
});

test("schedules: valid cron, a request, and every required input", () => {
  const wf = { nodes: [node("a")], inputs: [{ name: "topic", required: true }] };
  assert.deepEqual(codes({ ...wf, schedules: [{ cron: "0 7 * * 1-5", prompt: "daily", inputs: { topic: "AI" } }] }), []);
  const bad = codes({ ...wf, schedules: [{ cron: "7am", prompt: "" }] });
  for (const c of ["scheduleCronInvalid", "scheduleNoPrompt", "scheduleMissingInput"]) assert.ok(bad.includes(c), c);
});

test("team: a member's single agentId is migrated to an ordered agentIds list", () => {
  const wf = normalizeWorkflowInput({
    type: "team",
    team: { coordinator: { agentId: "a1" }, members: [{ alias: "fe", agentId: "a2", role: "x" }] },
  });
  assert.deepEqual(wf.team.members[0], { alias: "fe", agentIds: ["a2"], role: "x" });
  const member = wf.nodes.find((n) => n.id === "fe");
  assert.equal(member.agentId, "a2", "the node keeps its primary as agentId");
  assert.deepEqual(member.agentIds, ["a2"]);

  const listed = normalizeWorkflowInput({
    type: "team",
    team: { coordinator: { agentId: "a1" }, members: [{ alias: "fe", agentIds: ["a3", "a2"], role: "x" }] },
  });
  assert.deepEqual(listed.nodes.find((n) => n.id === "fe").agentIds, ["a3", "a2"]);
  assert.equal(listed.nodes.find((n) => n.id === "fe").agentId, "a3");
});

test("team: a member's agent list must be non-empty, known and without duplicates", () => {
  const team = (agentIds) => ({ type: "team", team: { coordinator: { agentId: "a1" }, members: [{ alias: "fe", agentIds, role: "x" }] } });
  assert.deepEqual(codes(team(["a2", "a3"])), []);
  assert.ok(codes(team([])).includes("memberNoAgent"));
  assert.ok(codes(team(["a2", "nope"])).includes("unknownAgent"));
  assert.ok(codes(team(["a2", "a2"])).includes("memberAgentDuplicate"));
});

test("team limits: safe defaults for teams saved without them, carried on the coordinator node", () => {
  const wf = normalizeWorkflowInput({ type: "team", team: { coordinator: { agentId: "a1" }, members: [{ alias: "fe", agentId: "a2", role: "x" }] } });
  assert.deepEqual(wf.team.limits, { maxDelegations: 30, callTimeoutMinutes: 30, runTokenBudget: 2_000_000 });
  assert.deepEqual(wf.nodes.find((n) => n.id === COORDINATOR_NODE_ID).teamLimits, wf.team.limits);

  const custom = normalizeWorkflowInput({
    type: "team",
    team: { coordinator: { agentId: "a1" }, members: [], limits: { maxDelegations: "5", callTimeoutMinutes: 0, runTokenBudget: 0 } },
  });
  assert.deepEqual(custom.team.limits, { maxDelegations: 5, callTimeoutMinutes: 1, runTokenBudget: 0 }, "0 tokens = no limit; a timeout is at least a minute");
});
