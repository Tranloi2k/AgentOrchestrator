import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createTeamCalls, itemKey, parseReviewVerdict } from "./team-calls.js";
import { openWorkspaceSession, createWorktree } from "../workspace/workspace.js";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
// Checkouts may turn LF into CRLF (core.autocrlf on Windows).
const read = (file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "ao-team-isolation-"));
  git(dir, "init");
  git(dir, "config", "user.name", "Team Test");
  git(dir, "config", "user.email", "team@test.local");
  writeFileSync(path.join(dir, "shared.txt"), "base\n", "utf8");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "initial");
  return dir;
}

const AGENTS = {
  fe: { id: "fe", name: "FE", provider: "claude", accessLevel: "write" },
  be: { id: "be", name: "BE", provider: "claude", accessLevel: "write" },
  rv: { id: "rv", name: "Reviewer", provider: "claude", accessLevel: "read" },
};

/**
 * A team run whose coordinator works in its own worktree of a real repo, with isolation on.
 * `write(opts)` is what the fake member does in the folder it was given; it returns its answer.
 */
async function setup(t, write, { delayMs = 0 } = {}) {
  const repo = makeRepo();
  const runId = `iso-${Math.random().toString(36).slice(2, 8)}`;
  t.after(() => rmSync(path.join(path.dirname(repo), ".ao-worktrees", runId), { recursive: true, force: true }));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const { session } = await openWorkspaceSession({ cwd: repo, runId, isolation: { enabled: true }, log: () => {} });
  const base = await createWorktree(session, "coordinator", () => {});

  const run = {
    id: runId,
    workflowId: "wf",
    workflowType: "team",
    workflowNodes: [
      { id: "coordinator", agentId: "fe", teamRole: "coordinator", calleeNodeIds: ["frontend", "backend", "reviewer"] },
      { id: "frontend", alias: "frontend", agentId: "fe", agentIds: ["fe"], role: "frontend", teamRole: "member", calleeNodeIds: [] },
      { id: "backend", alias: "backend", agentId: "be", agentIds: ["be"], role: "backend", teamRole: "member", calleeNodeIds: [] },
      { id: "reviewer", alias: "reviewer", agentId: "rv", agentIds: ["rv"], role: "reviewer", teamRole: "member", calleeNodeIds: [] },
    ],
    workflowEdges: [],
    workflowIsolation: { enabled: true },
    tasks: [{ id: "coord-task", nodeId: "coordinator", kind: "workflow-node", log: [] }],
    status: "running",
  };
  const calls = [];
  const live = { now: 0, max: 0 };
  let n = 0;
  const teamCalls = createTeamCalls({
    runs: new Map([[runId, run]]),
    getAgent: (id) => AGENTS[id],
    agentForNode: (node) => AGENTS[node.agentId],
    nodeTitle: (node) => node.alias || node.id,
    runAgentProcess: async (opts) => {
      calls.push(opts);
      live.max = Math.max(live.max, ++live.now);
      // Long enough for a parallel call to start too, so the test can see they overlapped.
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      live.now--;
      return { ok: true, resultText: await write(opts), usage: null, sessionId: null };
    },
    newTask: (title, kind, nodeId, agent) => ({ id: `t${++n}`, title, kind, nodeId, status: "pending", log: [], resultText: "", provider: "claude", agentId: agent?.id || null, usage: null }),
    emit: () => {},
    pushTaskLog: (runId_, taskId, line) => run.tasks.find((x) => x.id === taskId)?.log.push(line),
    isCancelling: () => false,
    providerAvailable: () => true,
    maxCallDepth: 3,
  });
  const keptDirs = [];
  teamCalls.openTeamWorkspace(runId, { session, base, keptDirs });
  const ask = (targetNodeId, question, workItemId, extra = {}) =>
    teamCalls.askAgent({ runId, workflowId: "wf", callerNodeId: "coordinator", targetNodeId, question, workItemId, parentWorkItemId: "root", cwd: base.dir, depth: 0, ...extra });
  const complete = (workItemId) => teamCalls.completeWorkItem({ runId, workItemId, callerTaskId: "coord-task" });
  return { repo, base, run, calls, live, ask, complete, teamCalls, keptDirs };
}

/** A fake member that writes `file` with `content` (taken from the question "file=content"). */
const writeFromQuestion = (opts) => {
  const [file, content] = opts.prompt.split("\n").at(-1).split("=");
  writeFileSync(path.join(opts.cwd, file), `${content}\n`, "utf8");
  return `wrote ${file}`;
};

test("two work items run in parallel in their own worktrees and both are integrated", async (t) => {
  const { repo, base, run, calls, live, ask, complete } = await setup(t, writeFromQuestion, { delayMs: 1500 });
  await Promise.all([ask("frontend", "ui.txt=the form", "ui"), ask("backend", "api.txt=the endpoint", "api")]);
  assert.equal(live.max, 2, "both members were working at the same time");

  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].cwd, calls[1].cwd, "each work item has its own folder");
  assert.ok(calls.every((c) => c.cwd !== base.dir));
  assert.ok(!existsSync(path.join(base.dir, "ui.txt")), "nothing lands in the base before it is completed");

  const ui = await complete("ui");
  const api = await complete("api");
  assert.equal(ui.ok, true, ui.message);
  assert.equal(api.ok, true, api.message);
  assert.equal(read(path.join(base.dir, "ui.txt")), "the form\n");
  assert.equal(read(path.join(base.dir, "api.txt")), "the endpoint\n");
  assert.equal(run.workItems.ui.status, "integrated");
  assert.ok(!existsSync(path.join(repo, "ui.txt")), "the repo's own branch is untouched until the run's review is accepted");
});

test("a fix round reuses the work item's worktree", async (t) => {
  const { calls, ask } = await setup(t, writeFromQuestion);
  await ask("frontend", "ui.txt=v1", "ui");
  await ask("frontend", "ui.txt=v2", "ui");
  assert.equal(calls[0].cwd, calls[1].cwd);
});

test("a conflicting pair: the second one is reported and nothing is half-merged", async (t) => {
  const { repo, base, run, ask, complete, keptDirs } = await setup(t, writeFromQuestion);
  await Promise.all([ask("frontend", "shared.txt=frontend version", "a"), ask("backend", "shared.txt=backend version", "b")]);

  const first = await complete("a");
  assert.equal(first.ok, true);
  const baseHead = git(base.dir, "rev-parse", "HEAD");

  const second = await complete("b");
  assert.equal(second.ok, false);
  assert.equal(second.reason, "conflict");
  assert.match(second.message, /xung đột/);
  assert.equal(git(base.dir, "rev-parse", "HEAD"), baseHead, "the coordinator's branch is where the first merge left it");
  assert.equal(git(base.dir, "status", "--porcelain"), "", "the aborted merge left no conflict markers behind");
  assert.equal(read(path.join(base.dir, "shared.txt")), "frontend version\n");
  assert.equal(read(path.join(repo, "shared.txt")), "base\n", "the repo's branch is untouched");
  assert.equal(run.workItems.b.status, "failed");
  assert.equal(keptDirs.length, 1, "the conflicting worktree is kept for inspection, as in a Pipeline");
});

test("a reviewer works in the reviewed item's worktree; passed items are merged at the end of the run, others kept", async (t) => {
  const { base, run, calls, ask, teamCalls } = await setup(t, (opts) => {
    if (opts.agent.id === "rv") return existsSync(path.join(opts.cwd, "ui.txt")) ? "Looks good.\nREVIEW: PASS" : "Missing file.\nREVIEW: FAIL";
    return writeFromQuestion(opts);
  });
  await ask("frontend", "ui.txt=the form", "ui");
  await ask("backend", "api.txt=the endpoint", "api");
  const review = await ask("reviewer", "Review the UI", "review-ui", { reviewOf: "ui" });
  assert.equal(calls[2].cwd, calls[0].cwd, "the reviewer reads the UI item's folder");
  assert.match(calls[2].prompt, /REVIEW: PASS/, "and is asked for a verdict");
  assert.equal(review.review, "passed");

  await ask("reviewer", "Look around", "look", {});
  assert.equal(calls[3].cwd, base.dir, "without reviewOf a read-only member works in the base");

  await teamCalls.finishWorkItems(run.id, () => {});
  assert.equal(run.workItems.ui.status, "integrated");
  assert.equal(run.workItems.api.status, "open", "never reviewed: not merged");
  assert.ok(existsSync(path.join(base.dir, "ui.txt")));
  assert.ok(!existsSync(path.join(base.dir, "api.txt")));
});

test("a new write after a passed review needs another review", async (t) => {
  const { run, ask } = await setup(t, (opts) => (opts.agent.id === "rv" ? "REVIEW: PASS" : writeFromQuestion(opts)));
  await ask("frontend", "ui.txt=v1", "ui");
  await ask("reviewer", "Review", "review-ui", { reviewOf: "ui" });
  assert.equal(run.workItems.ui.lastReview, "passed");
  await ask("frontend", "ui.txt=v2", "ui");
  assert.equal(run.workItems.ui.lastReview, null);
});

test("complete_work_item refuses what it can't merge", async (t) => {
  const { ask, complete, teamCalls, run } = await setup(t, writeFromQuestion);
  await assert.rejects(() => complete("nope"), /chưa có worktree/);
  await ask("frontend", "ui.txt=x", "ui");
  await complete("ui");
  await assert.rejects(() => complete("ui"), /đã được gộp/);
  teamCalls.closeTeamWorkspace(run.id);
  await assert.rejects(() => complete("ui"), /isolation tắt/);
});

test("work item keys and review verdicts", () => {
  assert.match(itemKey("Feature: Login UI"), /^feature-login-ui-[0-9a-f]{6}$/);
  assert.notEqual(itemKey("a/b"), itemKey("a b"));
  assert.equal(parseReviewVerdict("ok\n**REVIEW: PASS**"), "passed");
  assert.equal(parseReviewVerdict("REVIEW: PASS\n...\nREVIEW: fail"), "failed");
  assert.equal(parseReviewVerdict("looks fine"), null);
});
