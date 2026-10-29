import test from "node:test";
import assert from "node:assert/strict";
import { createTeamCalls, beginAttempt, coordinatorResumePlan, checkTeamLimits, teamLimitSummary } from "./team-calls.js";
import { finishDelegation } from "./delegation-policy.js";

const AGENTS = {
  claudeDev: { id: "claudeDev", name: "Claude dev", provider: "claude" },
  codexDev: { id: "codexDev", name: "Codex dev", provider: "codex" },
  agyDev: { id: "agyDev", name: "agy dev", provider: "gemini" },
};

/**
 * A team run with a coordinator and the given members ({ alias: agentId | [agentIds] }), plus a
 * fake runner that records every call and answers from `script` (or a default success).
 * `unavailable` lists providers whose CLI is "not installed"; `clock.now` is the run's time.
 */
function setup(members, script = [], { unavailable = [], limits = null } = {}) {
  const run = {
    id: "run1",
    workflowId: "wf1",
    workflowType: "team",
    workflowNodes: [
      { id: "coordinator", agentId: "claudeDev", teamRole: "coordinator", calleeNodeIds: Object.keys(members), ...(limits ? { teamLimits: limits } : {}) },
      ...Object.entries(members).map(([alias, ids]) => {
        const agentIds = [ids].flat();
        return { id: alias, alias, agentId: agentIds[0], agentIds, role: `role of ${alias}`, teamRole: "member", calleeNodeIds: [] };
      }),
    ],
    workflowEdges: [],
    tasks: [],
    status: "running",
  };
  const calls = [];
  const killed = [];
  const clock = { now: 1_000_000 };
  let n = 0;
  const runAgentProcess = async (opts) => {
    calls.push(opts);
    const next = script.shift();
    return next ? next(opts) : { ok: true, resultText: `answer ${calls.length}`, usage: null, sessionId: `${opts.agent.provider}-session-${calls.length}` };
  };
  const { askAgent } = createTeamCalls({
    runs: new Map([[run.id, run]]),
    getAgent: (id) => AGENTS[id] || Object.values(AGENTS)[0], // like the real one: falls back to the first agent
    agentForNode: (node) => AGENTS[node.agentId],
    nodeTitle: (node) => node.alias || node.id,
    runAgentProcess,
    newTask: (title, kind, nodeId, agent) => ({ id: `t${++n}`, title, kind, nodeId, status: "pending", log: [], resultText: "", provider: agent?.provider || "claude", agentId: agent?.id || null, usage: null }),
    emit: () => {},
    pushTaskLog: (runId, taskId, line) => run.tasks.find((t) => t.id === taskId)?.log.push(line),
    isCancelling: () => false,
    providerAvailable: (provider) => !unavailable.includes(provider),
    maxCallDepth: 3,
    now: () => clock.now,
    killTask: (taskId) => killed.push(taskId),
    minuteMs: 20, // a "minute" of callTimeoutMinutes lasts 20ms here
  });
  const ask = (targetNodeId, question, workItemId = "feature", extra = {}) =>
    askAgent({ runId: run.id, workflowId: "wf1", callerNodeId: "coordinator", targetNodeId, question, workItemId, cwd: "/repo", depth: 0, ...extra });
  return { run, calls, ask, clock, killed };
}

const quota = (quotaResetAt = null) => () => ({ ok: false, resultText: "", usage: { inputTokens: 1 }, failureReason: "quota", quotaResetAt });

test("a fix round for the same work item resumes the member's CLI session", async () => {
  const { run, calls, ask } = setup({ dev: "claudeDev" });
  await ask("dev", "Build the login form");
  await ask("dev", "Fix: the submit button is disabled");

  assert.equal(calls.length, 2);
  assert.equal(calls[0].resume, null);
  assert.equal(calls[1].resume, "claude-session-1", "the stored session id goes to the runner");
  assert.equal(calls[1].prompt, "Fix: the submit button is disabled", "a resumed session already has the role and history");
  assert.equal(run.delegations[0].sessionId, "claude-session-1");
  assert.equal(run.delegations[1].sessionId, "claude-session-2");
  assert.equal(run.tasks[1].continuation, "resumed");
  assert.ok(run.tasks[1].log.some((l) => l.includes("Tiếp tục phiên CLI")));
});

test("a new work item starts fresh", async () => {
  const { calls, ask } = setup({ dev: "claudeDev" });
  await ask("dev", "Build the login form", "feature");
  await ask("dev", "Build the signup form", "signup", { parentWorkItemId: "feature" });
  assert.equal(calls[1].resume, null);
  assert.ok(!calls[1].prompt.includes("lần giao trước"));
});

test("a failover to another member starts fresh, and so does coming back after it", async () => {
  const quota = () => ({ ok: false, resultText: "", usage: null, sessionId: "claude-quota-session", failureReason: "quota" });
  const { run, calls, ask } = setup({ main: "claudeDev", backup: "agyDev" }, [quota]);
  await ask("main", "Build the login form");
  await ask("backup", "Build the login form");
  assert.equal(calls[1].resume, null, "the backup never sees the main agent's session");
  assert.ok(!calls[1].prompt.includes("lần giao trước"));
  assert.equal(run.tasks[1].continuation, "fresh");

  await ask("backup", "Fix the review findings");
  assert.equal(calls[2].resume, "gemini-session-2", "the backup's own fix round resumes its own session");
});

test("a provider that cannot resume gets a transcript of the previous attempt", async () => {
  const { run, calls, ask } = setup({ dev: "codexDev" });
  await ask("dev", "Build the login form");
  await ask("dev", "Fix: the submit button is disabled");

  assert.equal(calls[1].resume, null);
  assert.match(calls[1].prompt, /role of dev/);
  assert.match(calls[1].prompt, /Build the login form/);
  assert.match(calls[1].prompt, /answer 1/);
  assert.match(calls[1].prompt, /Fix: the submit button is disabled/);
  assert.equal(run.tasks[1].continuation, "transcript");
});

test("a resume that fails falls back to a transcript in the same call", async () => {
  const resumeFails = () => ({ ok: false, resultText: "", usage: { inputTokens: 5 }, failureReason: "agent_error" });
  const { run, calls, ask } = setup({ dev: "claudeDev" }, [undefined, resumeFails]);
  await ask("dev", "Build the login form");
  await ask("dev", "Fix: the submit button is disabled");

  assert.equal(calls.length, 3);
  assert.equal(calls[1].resume, "claude-session-1");
  assert.equal(calls[2].resume, null);
  assert.match(calls[2].prompt, /answer 1/);
  assert.equal(run.tasks[1].continuation, "transcript");
  assert.equal(run.tasks[1].status, "done");
  assert.ok(run.tasks[1].log.some((l) => l.includes("Không mở lại được phiên cũ")));
});

test("resuming needs the same working folder (Claude keeps sessions per folder)", async () => {
  const { calls, ask } = setup({ dev: "claudeDev" });
  await ask("dev", "Build the login form");
  await ask("dev", "Fix it", "feature", { cwd: "/elsewhere" });
  assert.equal(calls[1].resume, null);
  assert.match(calls[1].prompt, /answer 1/);
});

test("a delegation saved before session tracking (no agentId) starts fresh", async () => {
  const { run, calls, ask } = setup({ dev: "claudeDev" });
  run.delegations = [];
  run.delegations.push(finishDelegation({ id: "old", callerNodeId: "coordinator", targetNodeId: "dev", workItemId: "feature", questionFingerprint: "x", status: "running" }, { ok: true }));
  await ask("dev", "Fix it");
  assert.equal(calls[0].resume, null);
  assert.equal(run.tasks[0].continuation, "fresh");
});

/** --------------------------- Phase 2: a member's ordered agent list --------------------------- */

test("agents whose CLI is not installed are skipped without spawning", async () => {
  const { run, calls, ask } = setup({ dev: ["codexDev", "claudeDev"] }, [], { unavailable: ["codex"] });
  const reply = await ask("dev", "Build the login form");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].agent.id, "claudeDev");
  assert.equal(reply.ok, true);
  assert.deepEqual(reply.agent, { id: "claudeDev", name: "Claude dev", provider: "claude" });
  assert.equal(run.tasks[0].agentId, "claudeDev");
  assert.ok(run.tasks[0].log.some((l) => l.includes("Bỏ qua Codex dev")));
  assert.ok(run.tasks[0].log.some((l) => l.includes("Thực hiện bởi Claude dev")));
});

test("a quota failure fails over to the member's next agent inside the same call", async () => {
  const { run, calls, ask } = setup({ dev: ["claudeDev", "agyDev"] }, [quota()]);
  const reply = await ask("dev", "Build the login form");

  assert.deepEqual(calls.map((c) => c.agent.id), ["claudeDev", "agyDev"]);
  assert.equal(reply.ok, true);
  assert.equal(reply.agent.id, "agyDev");
  assert.equal(run.delegations.length, 1, "the coordinator made one call; failover is not a new delegation");
  assert.equal(run.delegations[0].workItemId, "feature");
  assert.equal(run.delegations[0].agentId, "agyDev");
  assert.equal(run.tasks.length, 1);
  assert.equal(run.tasks[0].usage.inputTokens, 1, "the failed attempt's usage still counts");
  assert.equal(run.providerCooldowns.claude.reason, "quota");
});

test("a provider that hit quota is skipped by later calls in the same run, until its reset time", async () => {
  const { calls, ask, clock } = setup({ dev: ["claudeDev", "agyDev"], reviewer: ["claudeDev", "codexDev"] }, [quota(1_000_000 + 60_000)]);
  await ask("dev", "Build the login form");
  await ask("reviewer", "Review the login form", "review", { parentWorkItemId: "root" });
  await ask("dev", "Build the signup form", "signup", { parentWorkItemId: "root" });
  assert.deepEqual(calls.map((c) => c.agent.id), ["claudeDev", "agyDev", "codexDev", "agyDev"], "claude is not tried again while it is cooling down");

  clock.now += 61_000;
  await ask("dev", "Build the settings page", "settings", { parentWorkItemId: "root" });
  assert.equal(calls.at(-1).agent.id, "claudeDev", "after the parsed reset time claude is back");
});

test("without a reset time the cooldown lasts for the rest of the run", async () => {
  const { calls, ask, clock } = setup({ dev: ["claudeDev", "agyDev"] }, [quota(null)]);
  await ask("dev", "Build the login form");
  clock.now += 24 * 3600_000;
  await ask("dev", "Build the signup form", "signup", { parentWorkItemId: "root" });
  assert.equal(calls.at(-1).agent.id, "agyDev");
});

test("a work item stays on the agent that finished it, even once the primary is back", async () => {
  const { calls, ask, clock } = setup({ dev: ["claudeDev", "agyDev"] }, [quota(1_000_000 + 1000)]);
  await ask("dev", "Build the login form");
  clock.now += 10_000; // claude's quota is back

  await ask("dev", "Fix the review findings");
  assert.equal(calls[2].agent.id, "agyDev", "same work item: sticks to agy");
  assert.equal(calls[2].resume, "gemini-session-2", "and continues agy's session");

  await ask("dev", "Build the signup form", "signup", { parentWorkItemId: "root" });
  assert.equal(calls[3].agent.id, "claudeDev", "a new work item starts from the primary again");
});

test("a sticky agent that becomes unavailable hands the work item to the next agent in the list", async () => {
  const { calls, ask } = setup({ dev: ["claudeDev", "agyDev", "codexDev"] }, [quota(), undefined, quota()]);
  await ask("dev", "Build the login form"); // claude quota -> agy does it
  await ask("dev", "Fix the review findings"); // agy (sticky) hits quota -> codex
  assert.deepEqual(calls.map((c) => c.agent.id), ["claudeDev", "agyDev", "agyDev", "codexDev"]);
  assert.equal(calls[3].resume, null, "a different agent starts fresh");
});

test("when every agent of a member is out, the call fails cleanly without spawning", async () => {
  const { calls, ask } = setup({ dev: ["claudeDev", "agyDev"] }, [quota(), quota()]);
  const first = await ask("dev", "Build the login form");
  assert.equal(first.ok, false);
  assert.equal(first.failureReason, "quota");

  const second = await ask("dev", "Build the signup form", "signup", { parentWorkItemId: "root" });
  assert.equal(calls.length, 2, "both providers are cooling down, nothing is spawned");
  assert.equal(second.ok, false);
  assert.equal(second.failureReason, "quota");
});

test("an ordinary agent error does not fail over", async () => {
  const { calls, ask } = setup({ dev: ["claudeDev", "agyDev"] }, [() => ({ ok: false, resultText: "", usage: null, failureReason: "agent_error" })]);
  const reply = await ask("dev", "Build the login form");
  assert.equal(calls.length, 1);
  assert.equal(reply.ok, false);
  assert.equal(reply.failureReason, "agent_error");
});

test("the coordinator's delegation rules still apply across members", async () => {
  const { ask } = setup({ dev: ["claudeDev", "agyDev"], other: "codexDev" });
  await ask("dev", "Build the login form");
  await assert.rejects(() => ask("other", "Build the login form"), /Chỉ được đổi agent/);
});

test("a run snapshot from before agent lists (agentId only) still runs", async () => {
  const { run, calls, ask } = setup({ dev: "claudeDev" });
  delete run.workflowNodes[1].agentIds;
  const reply = await ask("dev", "Build the login form");
  assert.equal(calls[0].agent.id, "claudeDev");
  assert.equal(reply.agent.id, "claudeDev");
});

test("pipeline nodes keep their single agent and get no member failover", async () => {
  const { run, calls, ask } = setup({ dev: "claudeDev" }, [quota()], { unavailable: [] });
  run.workflowNodes[1].teamRole = undefined;
  delete run.workflowNodes[1].agentIds;
  const reply = await ask("dev", "Build the login form");
  assert.equal(calls.length, 1);
  assert.equal(reply.failureReason, "quota");
  assert.equal(reply.agent, undefined);
  assert.equal(run.providerCooldowns, undefined);
});

/** --------------------------- Phase 3: resuming a team run --------------------------- */

/** What loadRuns does to a delegation that was running when the server died. */
function crash(run) {
  for (const d of run.delegations) if (d.status === "running") Object.assign(d, { status: "error", failureReason: "interrupted" });
}

test("a resumed team run replays finished delegations and only runs the unfinished one", async () => {
  const hang = () => new Promise(() => {}); // the third member call never comes back: the server dies
  const { run, calls, ask } = setup({ dev: "claudeDev", reviewer: "agyDev" }, [undefined, undefined, hang]);
  await ask("dev", "Build the login form", "login", { parentWorkItemId: "root" });
  await ask("reviewer", "Review the login form", "review-login", { parentWorkItemId: "login" });
  ask("dev", "Build the signup form", "signup", { parentWorkItemId: "root" }); // left hanging
  await new Promise((r) => setImmediate(r));
  assert.equal(calls.length, 3);
  crash(run);

  beginAttempt(run); // what resumeRun does
  const a = await ask("dev", "Build the  login form", "login", { parentWorkItemId: "root" }); // same text, other spacing
  const b = await ask("reviewer", "Review the login form", "review-login", { parentWorkItemId: "login" });
  const c = await ask("dev", "Build the signup form", "signup", { parentWorkItemId: "root" });

  assert.equal(calls.length, 4, "only the unfinished work item spawned a process");
  assert.equal(calls[3].prompt.includes("Build the signup form"), true);
  assert.equal(a.answer, "answer 1");
  assert.equal(a.replayed, true);
  assert.equal(a.agent.id, "claudeDev");
  assert.equal(b.answer, "answer 2");
  assert.equal(c.replayed, undefined);
  const replayedTasks = run.tasks.filter((t) => t.continuation === "replayed");
  assert.equal(replayedTasks.length, 2);
  assert.ok(replayedTasks.every((t) => t.status === "done" && t.log.some((l) => l.includes("♻️"))));
});

test("after a replay, a fix round of the same work item continues the original session", async () => {
  const { run, calls, ask } = setup({ dev: "claudeDev" });
  await ask("dev", "Build the login form");
  beginAttempt(run);
  await ask("dev", "Build the login form");
  await ask("dev", "Fix: the submit button is disabled");
  assert.equal(calls.length, 2);
  assert.equal(calls[1].resume, "claude-session-1");
});

test("a changed question, a failed delegation or a chat turn is never replayed", async () => {
  const failed = () => ({ ok: false, resultText: "", usage: null, failureReason: "agent_error" });
  const { run, calls, ask } = setup({ dev: "claudeDev" }, [undefined, failed]);
  await ask("dev", "Build the login form", "login", { parentWorkItemId: "root" });
  await ask("dev", "Build the signup form", "signup", { parentWorkItemId: "root" }); // fails
  beginAttempt(run);

  await ask("dev", "Build the signup form", "signup", { parentWorkItemId: "root" });
  assert.equal(calls.length, 3, "the failed one runs again");
  await ask("dev", "Build the login form, now with a captcha", "login", { parentWorkItemId: "root" });
  assert.equal(calls.length, 4, "a different question runs");

  run.activeTurnId = "turn1";
  await ask("dev", "Build the login form", "login", { parentWorkItemId: "root" });
  assert.equal(calls.length, 5, "a chat turn asks for real");
});

test("a run that was never resumed doesn't replay a repeated question", async () => {
  const { calls, ask } = setup({ dev: "claudeDev" });
  await ask("dev", "Build the login form");
  await ask("dev", "Build the login form");
  assert.equal(calls.length, 2);
});

test("a resumed coordinator continues its own session, or starts with a summary of finished work", async () => {
  const { run, ask } = setup({ dev: "claudeDev" });
  const coordinator = run.workflowNodes[0];
  const agent = AGENTS.claudeDev;
  await ask("dev", "Build the login form", "login", { parentWorkItemId: "root" });
  run.tasks.push({ id: "c1", nodeId: "coordinator", kind: "workflow-node", agentId: "claudeDev", sessionId: "coord-session", cwd: "/wt/coordinator", log: [] });

  assert.equal(coordinatorResumePlan(run, coordinator, { agent, cwd: "/wt/coordinator" }), null, "not a resume yet");
  beginAttempt(run);

  const resumed = coordinatorResumePlan(run, coordinator, { agent, cwd: "/wt/coordinator" });
  assert.equal(resumed.mode, "resume");
  assert.equal(resumed.sessionId, "coord-session");
  assert.match(resumed.message, /login/);
  assert.match(resumed.preamble, /answer 1/, "the fallback summary is ready if the resume fails");

  const elsewhere = coordinatorResumePlan(run, coordinator, { agent, cwd: "/somewhere-else" });
  assert.equal(elsewhere.mode, "summary");
  assert.match(elsewhere.preamble, /\[login\] giao cho dev/);
  assert.match(elsewhere.preamble, /answer 1/);

  assert.equal(coordinatorResumePlan(run, coordinator, { agent: AGENTS.codexDev, cwd: "/wt/coordinator" }).mode, "summary", "codex can't resume");
});

/** --------------------------- Phase 5: limits for the whole run --------------------------- */

const LIMITS = { maxDelegations: 30, callTimeoutMinutes: 30, runTokenBudget: 0 };

test("maxDelegations: the call past the limit is a clean tool error, nothing is spawned or reserved", async () => {
  const { run, calls, ask } = setup({ dev: "claudeDev" }, [], { limits: { ...LIMITS, maxDelegations: 2 } });
  run.tasks.push({ id: "coord", nodeId: "coordinator", kind: "workflow-node", log: [] });
  await ask("dev", "Build the login form", "login", { parentWorkItemId: "root" });
  await ask("dev", "Build the signup form", "signup", { parentWorkItemId: "root" });
  await assert.rejects(
    () => ask("dev", "Build the settings page", "settings", { parentWorkItemId: "root", callerTaskId: "coord" }),
    (err) => /2\/2 lần/.test(err.message) && /báo cáo cuối cùng/.test(err.message)
  );
  assert.equal(calls.length, 2);
  assert.equal(run.delegations.length, 2, "the refused call reserved nothing");
  assert.ok(run.tasks.find((t) => t.id === "coord").log.some((l) => l.startsWith("⛔")), "the coordinator's log says why");
});

test("runTokenBudget: checked before each call against every task's tokens", async () => {
  const spend = () => ({ ok: true, resultText: "done", usage: { inputTokens: 400, outputTokens: 200 }, sessionId: null });
  const { run, calls, ask } = setup({ dev: "claudeDev" }, [spend, spend, spend], { limits: { ...LIMITS, runTokenBudget: 1000 } });
  run.tasks.push({ id: "coord", nodeId: "coordinator", kind: "workflow-node", log: [], usage: { inputTokens: 100 } }); // the coordinator counts too
  await ask("dev", "Build the login form", "login", { parentWorkItemId: "root" }); // 100 used before
  await ask("dev", "Build the signup form", "signup", { parentWorkItemId: "root" }); // 700 used before
  await assert.rejects(() => ask("dev", "Build the settings page", "settings", { parentWorkItemId: "root" }), /1,300\/1,000 token|1\.300\/1\.000 token/);
  assert.equal(calls.length, 2);
});

test("runTokenBudget 0 means no limit, and runs from before team limits have none", async () => {
  const spend = () => ({ ok: true, resultText: "done", usage: { inputTokens: 5_000_000 }, sessionId: null });
  const { calls, ask } = setup({ dev: "claudeDev" }, [spend, spend], { limits: { ...LIMITS, runTokenBudget: 0 } });
  await ask("dev", "a", "a", { parentWorkItemId: "root" });
  await ask("dev", "b", "b", { parentWorkItemId: "root" });
  assert.equal(calls.length, 2);

  const old = setup({ dev: "claudeDev" }); // no teamLimits on the snapshot's coordinator
  for (let i = 0; i < 35; i++) await old.ask("dev", `task ${i}`, `w${i}`, { parentWorkItemId: "root" });
  assert.equal(old.calls.length, 35);
});

test("callTimeoutMinutes: the call's process tree is killed and the call ends as timeout, with no failover or retry", async () => {
  let release;
  const hang = () => new Promise((resolve) => (release = resolve));
  const { run, calls, ask, killed } = setup({ dev: ["claudeDev", "agyDev"] }, [hang], { limits: { ...LIMITS, callTimeoutMinutes: 1 } });
  const pending = ask("dev", "Build the login form");
  await new Promise((r) => setTimeout(r, 60)); // past the 20ms "minute"
  assert.deepEqual(killed, [run.tasks[0].id], "the timer killed this call's task");
  release({ ok: false, resultText: "", usage: null, failureReason: "agent_error" }); // what a killed CLI reports
  const reply = await pending;

  assert.equal(reply.ok, false);
  assert.equal(reply.failureReason, "timeout");
  assert.equal(calls.length, 1, "no backup agent and no transcript retry after a timeout");
  assert.equal(run.tasks[0].status, "error");
  assert.equal(run.delegations[0].failureReason, "timeout");
  assert.ok(run.tasks[0].log.some((l) => l.startsWith("⏱️")));
});

test("a call that finishes in time is not touched by the timer", async () => {
  const { ask, killed } = setup({ dev: "claudeDev" }, [], { limits: { ...LIMITS, callTimeoutMinutes: 1 } });
  const reply = await ask("dev", "Build the login form");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(reply.ok, true);
  assert.deepEqual(killed, []);
});

test("a replayed call is neither counted nor refused at the limit", async () => {
  const { run, calls, ask } = setup({ dev: "claudeDev" }, [], { limits: { ...LIMITS, maxDelegations: 1 } });
  await ask("dev", "Build the login form", "login", { parentWorkItemId: "root" });
  beginAttempt(run);
  const replay = await ask("dev", "Build the login form", "login", { parentWorkItemId: "root" });
  assert.equal(replay.replayed, true);
  assert.equal(calls.length, 1);
  await assert.rejects(() => ask("dev", "Build the signup form", "signup", { parentWorkItemId: "root" }), /1\/1 lần/);
});

test("spawn_agent's check only looks at the token budget, and the Run tab gets usage against limits", () => {
  const run = {
    workflowType: "team",
    workflowNodes: [{ id: "coordinator", teamRole: "coordinator", teamLimits: { ...LIMITS, maxDelegations: 1, runTokenBudget: 1000 } }],
    delegations: [{ id: "d1" }, { id: "d2", replayedFrom: "d1" }],
    tasks: [{ usage: { inputTokens: 300, outputTokens: 100 } }],
  };
  assert.doesNotThrow(() => checkTeamLimits(run, run.workflowNodes[0].teamLimits, { delegation: false }));
  assert.throws(() => checkTeamLimits(run, run.workflowNodes[0].teamLimits), /1\/1 lần/);
  run.tasks.push({ usage: { outputTokens: 600 } });
  assert.throws(() => checkTeamLimits(run, run.workflowNodes[0].teamLimits, { delegation: false }), /token/);

  assert.deepEqual(teamLimitSummary(run), { delegations: 1, tokens: 1000, maxDelegations: 1, callTimeoutMinutes: 30, runTokenBudget: 1000 });
  assert.equal(teamLimitSummary({ ...run, workflowType: "pipeline" }), null);
});
