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
  const { askAgent, spawnBlueprint, spawnInline } = createTeamCalls({
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
  return { run, calls, ask, clock, killed, spawnBlueprint, spawnInline };
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

test("a new work item for the same member reuses its last session (same folder), marked as new work", async () => {
  const { run, calls, ask } = setup({ dev: "claudeDev" });
  await ask("dev", "Build the login form", "feature");
  await ask("dev", "Build the signup form", "signup", { parentWorkItemId: "feature" });
  assert.equal(calls[1].resume, "claude-session-1", "it keeps what it read and learned");
  assert.match(calls[1].prompt, /VIỆC MỚI \[signup\]/);
  assert.match(calls[1].prompt, /khác với việc \[feature\]/);
  assert.ok(!calls[1].prompt.includes("lần giao trước"), "not a fix round");
  assert.equal(run.tasks[1].continuation, "reused");
  assert.equal(run.delegations[1].sessionItems, 2);
});

test("a reused session takes at most 4 work items, then starts over with a briefing", async () => {
  const { run, calls, ask } = setup({ dev: "claudeDev" });
  for (const item of ["a", "b", "c", "d", "e"]) await ask("dev", `Do ${item}`, item, item === "a" ? {} : { parentWorkItemId: "a" });
  assert.deepEqual(calls.map((c) => !!c.resume), [false, true, true, true, false]);
  assert.equal(run.tasks[4].continuation, "briefed");
  assert.match(calls[4].prompt, /đã làm xong các việc/);
  assert.match(calls[4].prompt, /\[d\]\nanswer 4/, "the briefing carries earlier answers");
  assert.match(calls[4].prompt, /role of dev/, "a fresh start still gets its role");
  await ask("dev", "Do f", "f", { parentWorkItemId: "a" });
  assert.equal(calls[5].resume, "claude-session-5", "the new session is reused from then on");
});

test("a new work item in another folder, or while the member is busy, gets a briefing instead of the session", async () => {
  const { run, calls, ask } = setup({ dev: "claudeDev" });
  await ask("dev", "Build the login form", "feature");
  await ask("dev", "Build the signup form", "signup", { cwd: "/wt/signup", parentWorkItemId: "feature" });
  assert.equal(calls[1].resume, null, "Claude keeps sessions per folder");
  assert.match(calls[1].prompt, /\[feature\]\nanswer 1/);
  assert.equal(run.tasks[1].continuation, "briefed");

  // Two new items at once: only one may continue the session.
  const there = { cwd: "/wt/signup", parentWorkItemId: "feature" }; // same folder as the last item
  await Promise.all([ask("dev", "Build A", "a", there), ask("dev", "Build B", "b", there)]);
  assert.equal(calls.slice(2).filter((c) => c.resume).length, 1);
});

test("a reused session that fails falls back to a briefed fresh start in the same call", async () => {
  const broken = () => ({ ok: false, resultText: "", usage: { inputTokens: 3 }, failureReason: "agent_error" });
  const { run, calls, ask } = setup({ dev: "claudeDev" }, [undefined, broken]);
  const reply = await ask("dev", "Build the signup form", "signup").then(() => ask("dev", "Build the reset form", "reset", { parentWorkItemId: "signup" }));
  assert.equal(calls[1].resume, "claude-session-1");
  assert.equal(calls[2].resume, null);
  assert.match(calls[2].prompt, /\[signup\]/);
  assert.equal(reply.ok, true);
  assert.equal(run.tasks[1].continuation, "briefed");
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

for (const reason of ["tool_denied", "no_output"]) {
  test(`${reason}: a member with [agy, claude] moves to Claude in the same call, without a cooldown`, async () => {
    const fails = () => ({ ok: false, resultText: "", usage: { inputTokens: 2 }, failureReason: reason });
    const { run, calls, ask } = setup({ painter: ["agyDev", "claudeDev"] }, [fails]);
    const reply = await ask("painter", "Make the logo");

    assert.deepEqual(calls.map((c) => c.agent.id), ["agyDev", "claudeDev"]);
    assert.equal(reply.ok, true);
    assert.equal(reply.agent.id, "claudeDev");
    assert.equal(run.delegations.length, 1, "one call from the coordinator");
    assert.equal(run.delegations[0].agentId, "claudeDev");
    assert.equal(run.providerCooldowns?.gemini, undefined, "the same provider may still work for another job");
    assert.deepEqual(
      run.tasks[0].fallbackLog.map((e) => [e.provider, e.outcome]),
      [["gemini", reason], ["claude", "done"]]
    );
    assert.ok(run.tasks[0].log.some((l) => l.includes("không làm được việc này") && l.includes(`[${reason}]`)), "the reason is logged in plain words");

    await ask("painter", "Make the banner", "banner", { parentWorkItemId: "root" });
    assert.equal(calls.at(-1).agent.id, "agyDev", "a new job starts on agy again");
  });
}

for (const [label, answer] of [
  ["a CAPABILITY_UNAVAILABLE line", () => ({ ok: true, resultText: "CAPABILITY_UNAVAILABLE: image generation\nCould draw an SVG instead.", usage: null, sessionId: "agy-1" })],
  ["a capability_unavailable failure", () => ({ ok: false, resultText: "Image generation is not available", usage: null, failureReason: "capability_unavailable" })],
]) {
  test(`${label}: no provider switch, the agent's answer goes back to the coordinator`, async () => {
    const { run, calls, ask } = setup({ painter: ["agyDev", "claudeDev"] }, [answer]);
    const reply = await ask("painter", "Make the logo");

    assert.match(calls[0].prompt, /CAPABILITY_UNAVAILABLE/, "a member is told how to say it has no tool");
    assert.equal(calls.length, 1, "Claude is not tried: the coordinator decides");
    assert.equal(reply.ok, false);
    assert.equal(reply.failureReason, "capability_unavailable");
    assert.equal(reply.answer, run.tasks[0].resultText);
    assert.ok(reply.answer.length > 0, "the stopped agent's answer is what the coordinator gets");
    assert.equal(reply.agent.id, "agyDev");
    assert.equal(run.providerCooldowns?.gemini, undefined);
    assert.ok(run.tasks[0].log.some((l) => l.includes("điều phối viên quyết định")));
  });
}

test("after capability_unavailable the coordinator may hand the same work item to another member", async () => {
  const noTool = () => ({ ok: true, resultText: "CAPABILITY_UNAVAILABLE: image generation", usage: null });
  const { calls, ask } = setup({ painter: "agyDev", designer: "claudeDev" }, [noTool]);
  await ask("painter", "Make the logo");
  const reply = await ask("designer", "Make the logo as an SVG");
  assert.equal(reply.ok, true);
  assert.equal(calls[1].agent.id, "claudeDev");
});

test("a resumed fix round is not told about CAPABILITY_UNAVAILABLE again", async () => {
  const { calls, ask } = setup({ dev: "claudeDev" });
  await ask("dev", "Build the login form");
  await ask("dev", "Fix it");
  assert.match(calls[0].prompt, /CAPABILITY_UNAVAILABLE/);
  assert.equal(calls[1].prompt, "Fix it");
});

test("a job-level failure on the last agent ends the call with that reason", async () => {
  const denied = () => ({ ok: false, resultText: "", usage: null, failureReason: "tool_denied" });
  const { run, ask } = setup({ painter: ["agyDev", "claudeDev"] }, [denied, denied]);
  const reply = await ask("painter", "Make the logo");
  assert.equal(reply.ok, false);
  assert.equal(reply.failureReason, "tool_denied");
  assert.equal(run.delegations[0].failureReason, "tool_denied");
});

test("an ordinary agent error on agy still does not move to Claude", async () => {
  const { run, calls, ask } = setup({ painter: ["agyDev", "claudeDev"] }, [() => ({ ok: false, resultText: "", usage: null, failureReason: "agent_error" })]);
  const reply = await ask("painter", "Make the logo");
  assert.equal(calls.length, 1);
  assert.equal(reply.failureReason, "agent_error");
  assert.deepEqual(run.tasks[0].fallbackLog.map((e) => e.outcome), ["agent_error"]);
});

test("a resumed session that is denied a tool fails over instead of retrying the same agent", async () => {
  const denied = () => ({ ok: false, resultText: "", usage: null, failureReason: "tool_denied" });
  const { calls, ask } = setup({ painter: ["agyDev", "claudeDev"] }, [undefined, denied]);
  await ask("painter", "Make the logo");
  await ask("painter", "Make it blue");
  assert.equal(calls[1].resume, "gemini-session-1");
  assert.deepEqual(calls.slice(1).map((c) => [c.agent.id, c.resume]), [["agyDev", "gemini-session-1"], ["claudeDev", null]]);
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

/** --------------------------- spawn_agent with a blueprint --------------------------- */

const PAINTER = {
  name: "painter",
  role: "Makes the images the job needs",
  instructions: "You make images.",
  skillIds: ["brand"],
  accessLevel: "write",
  providers: [
    { provider: "gemini", model: "", instructions: "Generate a PNG bitmap." },
    { provider: "claude", model: "sonnet", instructions: "You cannot make bitmaps: draw an SVG instead." },
  ],
  tools: null,
};
const WRITER = { name: "writer", role: "Writes copy", instructions: "You write.", skillIds: [], accessLevel: "read", providers: [{ provider: "claude", model: "", instructions: "" }], tools: null };

/** A team run whose coordinator may spawn the given blueprints, plus a spawn helper. */
function spawnSetup(script = [], { blueprints = [PAINTER, WRITER], maxAgents = 5, unavailable = [], supervisorLevel = "write", members = { dev: "claudeDev" } } = {}) {
  const t = setup(members, script, { unavailable });
  const supervisor = {
    ...AGENTS.claudeDev,
    accessLevel: supervisorLevel,
    allowedTools: ["Read", "Edit", "Write"],
    spawnPolicy: { enabled: true, providers: [], maxAgents, tokenBudget: 0 },
    blueprints,
  };
  const spawn = (blueprint, prompt, workItemId = "logo", extra = {}) =>
    t.spawnBlueprint({ runId: t.run.id, callerNodeId: "coordinator", callerTaskId: null, supervisor, blueprint, prompt, workItemId, cwd: "/repo", depth: 0, ...extra });
  return { ...t, spawn, supervisor };
}

const fails = (failureReason) => () => ({ ok: false, resultText: "", usage: null, failureReason });

test("blueprint: walks its providers, skipping a missing CLI, and says who did the work", async () => {
  const { run, calls, spawn } = spawnSetup([], { unavailable: ["gemini"] });
  const reply = await spawn("painter", "Make the logo");

  assert.equal(calls.length, 1, "agy is not installed: skipped without a process");
  assert.equal(calls[0].agent.provider, "claude");
  assert.equal(reply.ok, true);
  assert.equal(reply.agent.provider, "claude");
  assert.equal(reply.blueprint, "painter");
  const task = run.tasks.find((x) => x.kind === "agent-spawn");
  assert.equal(task.spawn.provider, "claude");
  assert.deepEqual(task.fallbackLog.map((e) => [e.provider, e.outcome]), [["gemini", "skipped:provider_unavailable"], ["claude", "done"]]);
});

test("blueprint: a failover reason on one provider moves the same call to the next, and reports why", async () => {
  for (const reason of ["tool_denied", "no_output", "quota"]) {
    const { run, calls, spawn } = spawnSetup([fails(reason)]);
    const reply = await spawn("painter", "Make the logo");
    assert.deepEqual(calls.map((c) => c.agent.provider), ["gemini", "claude"], reason);
    assert.equal(reply.ok, true);
    assert.deepEqual(reply.stopped.map((s) => [s.provider, s.reason]), [["gemini", reason]]);
    assert.equal(!!run.providerCooldowns?.gemini, reason === "quota", "only quota sidelines the provider");
  }
});

test("blueprint: a missing capability also moves on (the next provider has its own instructions), with the answer kept", async () => {
  const noTool = () => ({ ok: true, resultText: "CAPABILITY_UNAVAILABLE: image generation", usage: null });
  const { calls, spawn } = spawnSetup([noTool]);
  const reply = await spawn("painter", "Make the logo");
  assert.deepEqual(calls.map((c) => c.agent.provider), ["gemini", "claude"]);
  assert.equal(reply.ok, true);
  assert.equal(reply.stopped[0].reason, "capability_unavailable");
  assert.match(reply.stopped[0].answer, /image generation/);
});

test("blueprint: an ordinary error does not move to the next provider", async () => {
  const { calls, spawn } = spawnSetup([fails("agent_error")]);
  const reply = await spawn("painter", "Make the logo");
  assert.equal(calls.length, 1);
  assert.equal(reply.ok, false);
  assert.equal(reply.failureReason, "agent_error");
});

test("blueprint: instructions, skills and access come from the blueprint; per-provider instructions only for that provider", async () => {
  const { calls, spawn } = spawnSetup([fails("tool_denied")]);
  await spawn("painter", "Make the logo");
  const [agy, claude] = calls.map((c) => c.agent);
  assert.equal(agy.appendSystemPrompt, "You make images.\n\nGenerate a PNG bitmap.");
  assert.equal(claude.appendSystemPrompt, "You make images.\n\nYou cannot make bitmaps: draw an SVG instead.");
  assert.deepEqual(agy.skillIds, ["brand"]);
  assert.equal(claude.model, "sonnet");
  assert.equal(agy.accessLevel, "write");
  assert.equal(agy.agyMode, "accept-edits");
  assert.equal(claude.permissionMode, "acceptEdits");
  assert.deepEqual(claude.allowedTools, ["Read", "Edit", "Write"], "the supervisor's tools when the blueprint sets none");
  assert.match(calls[0].prompt, /painter/, "a fresh start gets its role");
  assert.match(calls[0].prompt, /Make the logo/);
});

test("blueprint: a fix round with the same workItemId resumes the session on the provider that did the work", async () => {
  const { run, calls, spawn } = spawnSetup([fails("tool_denied")]);
  await spawn("painter", "Make the logo");
  await spawn("painter", "Make it blue");

  assert.deepEqual(calls.map((c) => c.agent.provider), ["gemini", "claude", "claude"], "sticks to Claude for this work item");
  assert.equal(calls[2].resume, "claude-session-2");
  assert.equal(calls[2].prompt, "Make it blue", "a resumed session only gets the new message");
  const tasks = run.tasks.filter((x) => x.kind === "agent-spawn");
  assert.equal(tasks[1].continuation, "resumed");

  await spawn("painter", "Make the banner", "banner");
  assert.equal(calls.at(-1).agent.provider, "gemini", "a new work item starts from the first provider again");
  assert.equal(calls.at(-1).resume, null);
});

test("blueprint: maxAgents counts agents, not work items, fix rounds or provider switches", async () => {
  const { spawn } = spawnSetup([fails("tool_denied")], { maxAgents: 2 });
  await spawn("painter", "Make the logo", "logo"); // two providers tried: still one agent
  await spawn("painter", "Make it blue", "logo"); // fix round
  const second = await spawn("writer", "Write the tagline", "tagline");
  assert.equal(second.usage.spawned, 2);
  const banner = await spawn("painter", "Make the banner", "banner");
  assert.equal(banner.ok, true, "the same agent takes a new work item without a new slot");
  assert.equal(banner.usage.spawned, 2);
  assert.deepEqual(
    banner.usage.agents.map((a) => [a.name, a.workItems, a.busy]),
    [["painter", ["logo", "banner"], 0], ["writer", ["tagline"], 0]],
    "the coordinator is told who exists"
  );
});

test("blueprint: running the same agent on two work items at once takes a second slot", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const slow = async () => {
    await gate;
    return { ok: true, resultText: "logo done", usage: null, sessionId: "s-slow" };
  };
  const { run, spawn } = spawnSetup([slow, slow], { maxAgents: 2, blueprints: [WRITER] });
  const first = spawn("writer", "Write the tagline", "tagline");
  const second = spawn("writer", "Write the footer", "footer"); // tagline still running: a second copy
  await assert.rejects(() => spawn("writer", "Write the header", "header"), /Đã tạo đủ 2 agent/, "both copies busy");
  release();
  assert.equal((await second).usage.spawned, 2);
  await first;
  const instances = run.tasks.filter((x) => x.kind === "agent-spawn").map((x) => x.spawn.instance);
  assert.deepEqual(instances, [1, 2]);
  const later = await spawn("writer", "Write the header", "header");
  assert.equal(later.ok, true, "once one is free, it takes the new work in an existing slot");
});

test("inline: a name already defined in the run is that agent; new work needs only name + workItemId", async () => {
  const { run, calls, spawnInline, supervisor } = spawnSetup([], { blueprints: [] });
  const policy = { ...supervisor.spawnPolicy, providers: ["gemini", "claude"], claudeModels: [], geminiModels: [], opencodeModels: [], maxAccessLevel: "write" };
  const call = (extra) =>
    spawnInline({ runId: run.id, callerNodeId: "coordinator", supervisor: { ...supervisor, spawnPolicy: policy }, cwd: "/repo", depth: 0, ...extra });
  await call({ name: "Backend-Dev", role: "API work", instructions: "You build APIs.", provider: "gemini", accessLevel: "write", workItemId: "users", prompt: "Add /users" });
  const reply = await call({ name: "backend-dev", workItemId: "orders", prompt: "Add /orders" });
  assert.equal(reply.ok, true);
  assert.equal(calls[1].agent.provider, "gemini", "provider comes from the first definition");
  assert.equal(calls[1].agent.accessLevel, "write");
  assert.match(calls[1].agent.appendSystemPrompt, /You build APIs/);
  assert.equal(calls[1].resume, "gemini-session-1", "and it continues its own session");
  assert.equal(reply.usage.spawned, 1);
});

test("blueprint: a resumed coordinator gets a finished spawn replayed, without a process", async () => {
  const { run, calls, spawn } = spawnSetup();
  await spawn("painter", "Make the logo");
  beginAttempt(run);
  const reply = await spawn("painter", "Make the logo");
  assert.equal(calls.length, 1, "nothing is spawned again");
  assert.equal(reply.ok, true);
  assert.equal(reply.replayed, true);
  assert.equal(reply.answer, "answer 1");
  const replayed = run.tasks.filter((x) => x.kind === "agent-spawn").at(-1);
  assert.equal(replayed.continuation, "replayed");
  assert.equal(reply.usage.spawned, 1, "a replay is not a new agent");

  await spawn("painter", "Make it blue");
  assert.equal(calls[1].resume, "gemini-session-1", "a later fix round still continues the original session");
});

test("blueprint: unknown name, missing workItemId and access above the supervisor are refused before anything runs", async () => {
  const { run, calls, spawn } = spawnSetup([], { supervisorLevel: "read" });
  await assert.rejects(() => spawn("ghost", "x"), /Không có blueprint "ghost"/);
  await assert.rejects(() => spawn("painter", "x", ""), /cần workItemId/);
  await assert.rejects(() => spawn("painter", "x"), /vượt quá quyền tối đa/);
  assert.equal(calls.length, 0);
  assert.equal(run.tasks.length, 0);
  assert.equal((run.delegations || []).length, 0);
});

test("blueprint spawns leave the ask_agent rules alone and are not counted as hand-offs", async () => {
  const { run, spawn, ask } = spawnSetup();
  await spawn("painter", "Make the logo", "logo");
  const reply = await ask("dev", "Build the login form", "feature");
  assert.equal(reply.ok, true, "the first ask_agent work item needs no parent because of a spawn");
  run.workflowNodes[0].teamLimits = { maxDelegations: 30, callTimeoutMinutes: 30, runTokenBudget: 0 };
  assert.equal(teamLimitSummary(run).delegations, 1);
});

/** --------------------------- the Team's access ceiling for spawns --------------------------- */

test("ceiling: a read-only coordinator spawns a write blueprint under maxAccessLevel write", async () => {
  const { calls, spawn, supervisor } = spawnSetup([], { supervisorLevel: "read" });
  supervisor.allowedTools = ["Read", "Grep", "Glob"];
  supervisor.spawnPolicy = { ...supervisor.spawnPolicy, maxAccessLevel: "write" };
  const reply = await spawn("painter", "Make the logo");

  assert.equal(reply.ok, true);
  const agent = calls[0].agent;
  assert.equal(agent.accessLevel, "write");
  assert.equal(agent.agyMode, "accept-edits");
  const claude = (await spawnClaude(supervisor)).agent;
  assert.ok(claude.allowedTools.includes("Edit"), "write tools are available up to the Team's level, beyond the coordinator's own allowlist");
  assert.ok(!claude.allowedTools.includes("Task"));
});

test("ceiling: the same request is refused under the default (read), before anything runs", async () => {
  const { run, calls, spawn, supervisor } = spawnSetup([], { supervisorLevel: "read" });
  supervisor.spawnPolicy = { ...supervisor.spawnPolicy, maxAccessLevel: "read" };
  await assert.rejects(() => spawn("painter", "Make the logo"), /vượt quá quyền tối đa "read" mà Team cho phép/);
  assert.equal(calls.length, 0);
  assert.equal(run.tasks.length, 0);
  const reply = await spawn("writer", "Write the tagline", "tagline");
  assert.equal(reply.ok, true, "a read blueprint is still fine");
});

test("ceiling: a write coordinator can't hand out write when the Team keeps the default read", async () => {
  const { spawn, supervisor } = spawnSetup([], { supervisorLevel: "write" });
  supervisor.spawnPolicy = { ...supervisor.spawnPolicy, maxAccessLevel: "read" };
  await assert.rejects(() => spawn("painter", "Make the logo"), /mà Team cho phép/);
});

/** A Claude-only write blueprint spawned once, to look at the tools it gets. */
async function spawnClaude(supervisor) {
  const t = setup({ dev: "claudeDev" });
  const bp = { ...PAINTER, name: "svg", providers: [{ provider: "claude", model: "", instructions: "" }] };
  const sup = { ...supervisor, blueprints: [bp] };
  await t.spawnBlueprint({ runId: t.run.id, callerNodeId: "coordinator", supervisor: sup, blueprint: "svg", prompt: "x", workItemId: "x", cwd: "/repo", depth: 0 });
  return t.calls[0];
}

/** --------------------------- a Team without fixed members --------------------------- */

test("no members: the coordinator spawns two blueprints and gets both answers", async () => {
  const answers = [
    (opts) => ({ ok: true, resultText: `logo by ${opts.agent.provider}`, usage: null, sessionId: "agy-1" }),
    (opts) => ({ ok: true, resultText: `tagline by ${opts.agent.provider}`, usage: null, sessionId: "claude-1" }),
  ];
  const { run, calls, spawn } = spawnSetup(answers, { members: {} });
  assert.deepEqual(run.workflowNodes.map((n) => n.id), ["coordinator"], "nobody but the coordinator");

  const [logo, tagline] = await Promise.all([spawn("painter", "Make the logo", "logo"), spawn("writer", "Write the tagline", "tagline")]);

  assert.equal(logo.ok, true);
  assert.equal(logo.answer, "logo by gemini");
  assert.equal(logo.blueprint, "painter");
  assert.equal(tagline.ok, true);
  assert.equal(tagline.answer, "tagline by claude");
  assert.equal(tagline.blueprint, "writer");
  assert.equal(calls.length, 2);
  assert.equal(tagline.usage.spawned, 2);
  const spawned = run.tasks.filter((x) => x.kind === "agent-spawn");
  assert.deepEqual(spawned.map((x) => [x.workItemId, x.status, x.spawn.blueprint]), [["logo", "done", "painter"], ["tagline", "done", "writer"]]);
  assert.deepEqual(run.delegations.map((d) => [d.kind, d.targetNodeId, d.status]), [["spawn", "blueprint:painter", "done"], ["spawn", "blueprint:writer", "done"]]);
});

test("fixed members keep working next to blueprints, with their own agent fallback", async () => {
  const { calls, ask, spawn } = spawnSetup([fails("tool_denied")], { members: { dev: ["agyDev", "claudeDev"] } });
  const member = await ask("dev", "Build the login form", "feature");
  assert.equal(member.ok, true);
  assert.equal(member.agent.id, "claudeDev", "the member's agentIds fallback still runs");
  const spawned = await spawn("writer", "Write the tagline", "tagline");
  assert.equal(spawned.ok, true);
  assert.deepEqual(calls.map((c) => c.agent.id), ["agyDev", "claudeDev", "blueprint:writer#0:claude"]);
});

/** --------------------------- spawn_agent with an agent the coordinator defines --------------------------- */

test("inline spawn: the coordinator's own role and instructions, continued per name and workItemId", async () => {
  const { run, calls, spawnInline, supervisor } = spawnSetup([], { blueprints: [], members: {} });
  supervisor.spawnPolicy = { ...supervisor.spawnPolicy, providers: ["claude"], claudeModels: [], codexModels: [], geminiModels: [], maxAccessLevel: "write" };
  const spawn = (prompt, workItemId = "api", extra = {}) =>
    spawnInline({ runId: run.id, callerNodeId: "coordinator", supervisor, name: "backend-dev", role: "Builds the API", instructions: "You write Node.", provider: "claude", accessLevel: "write", prompt, workItemId, cwd: "/repo", depth: 0, ...extra });

  const first = await spawn("Build the login endpoint");
  assert.equal(first.ok, true);
  assert.equal(first.blueprint, "backend-dev");
  assert.equal(calls[0].agent.appendSystemPrompt, "You write Node.");
  assert.equal(calls[0].agent.accessLevel, "write");
  const task = run.tasks.find((x) => x.kind === "agent-spawn");
  assert.equal(task.spawn.inline, true);
  assert.equal(task.spawn.role, "Builds the API");
  assert.equal(run.delegations[0].targetNodeId, "spawn:backend-dev");

  await spawn("Fix: return 401 on a bad password");
  assert.equal(calls[1].resume, "claude-session-1", "the same name and workItemId resume the agent's session");
  assert.equal(first.usage.spawned, 1);
  await assert.rejects(spawn("Another", ""), /workItemId/);
});

test("inline spawn: may not shadow a stored blueprint, and stays inside the policy", async () => {
  const { run, spawnInline, supervisor } = spawnSetup();
  supervisor.spawnPolicy = { ...supervisor.spawnPolicy, providers: ["claude"], claudeModels: [], codexModels: [], geminiModels: [] };
  const call = { runId: run.id, callerNodeId: "coordinator", supervisor, prompt: "Do it", workItemId: "x", cwd: "/repo", depth: 0 };
  await assert.rejects(spawnInline({ ...call, name: "painter", provider: "claude" }), /tên một blueprint/);
  await assert.rejects(spawnInline({ ...call, name: "dev", provider: "codex" }), /không nằm trong danh sách/);
});

test("maxParallel: calls over the limit wait their turn (pending) instead of failing, members and spawns together", async () => {
  let running = 0;
  let peak = 0;
  const gates = [];
  const held = () => async () => {
    running++;
    peak = Math.max(peak, running);
    await new Promise((r) => gates.push(r));
    running--;
    return { ok: true, resultText: "done", usage: null, sessionId: null };
  };
  const limits = { maxDelegations: 30, callTimeoutMinutes: 30, runTokenBudget: 0, maxParallel: 2 };
  const t = setup({ dev: "claudeDev", qa: "agyDev" }, [held(), held(), held()], { limits });
  const supervisor = { ...AGENTS.claudeDev, accessLevel: "write", spawnPolicy: { enabled: true, providers: [], maxAgents: 5, tokenBudget: 0 }, blueprints: [WRITER] };

  const a = t.ask("dev", "Build A", "a");
  const b = t.ask("qa", "Test B", "b", { parentWorkItemId: "a" });
  const c = t.spawnBlueprint({ runId: t.run.id, callerNodeId: "coordinator", supervisor, blueprint: "writer", prompt: "Write C", workItemId: "c", cwd: "/repo", depth: 0 });
  await new Promise((r) => setImmediate(r));

  assert.equal(t.calls.length, 2, "only two run");
  const third = t.run.tasks.find((x) => x.kind === "agent-spawn");
  assert.equal(third.status, "pending", "the third waits");
  assert.ok(third.log.some((l) => l.includes("2/2 agent chạy cùng lúc")));

  gates.shift()(); // one finishes: the waiting one starts
  await a;
  await new Promise((r) => setImmediate(r));
  assert.equal(t.calls.length, 3);
  assert.equal(third.status, "running");
  gates.splice(0).forEach((g) => g());
  await new Promise((r) => setImmediate(r));
  gates.splice(0).forEach((g) => g());
  const replies = await Promise.all([b, c]);
  assert.ok(replies.every((r) => r.ok));
  assert.equal(peak, 2, "never more than two at once");
});

test("maxParallel: a run without the limit (older snapshots) runs everything at once", async () => {
  const t = setup({ dev: "claudeDev", qa: "agyDev" }, [], { limits: { maxDelegations: 30, callTimeoutMinutes: 30, runTokenBudget: 0 } });
  await Promise.all([t.ask("dev", "A", "a"), t.ask("qa", "B", "b", { parentWorkItemId: "a" })]);
  assert.equal(t.calls.length, 2);
});
