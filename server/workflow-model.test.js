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
