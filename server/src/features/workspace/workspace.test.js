import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  openWorkspaceSession,
  createWorktree,
  integrateWorktree,
  finalizeWorkspaceReview,
  acceptWorkspaceReview,
  declineWorkspaceReview,
} from "./workspace.js";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function makeRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "ao-review-test-"));
  git(dir, "init");
  git(dir, "config", "user.name", "Review Test");
  git(dir, "config", "user.email", "review@test.local");
  writeFileSync(path.join(dir, "sample.txt"), "before\n", "utf8");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "initial");
  return dir;
}

test("review keeps base unchanged until accepted", async (t) => {
  const repo = makeRepo();
  t.after(() =>
    rmSync(path.join(path.dirname(repo), ".ao-worktrees", "accept-test"), {
      recursive: true,
      force: true,
    })
  );
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  const { session } = await openWorkspaceSession({
    cwd: repo,
    runId: "accept-test",
    isolation: {},
    log: () => {},
  });
  assert.ok(session);
  writeFileSync(path.join(session.reviewDir, "sample.txt"), "after\n", "utf8");

  const review = await finalizeWorkspaceReview(session, () => {});
  assert.equal(review.status, "pending");
  assert.equal(review.files[0].path, "sample.txt");
  assert.equal(readFileSync(path.join(repo, "sample.txt"), "utf8"), "before\n");

  await acceptWorkspaceReview(review);
  assert.equal(readFileSync(path.join(repo, "sample.txt"), "utf8").replaceAll("\r\n", "\n"), "after\n");
});

test("decline removes review without touching base", async (t) => {
  const repo = makeRepo();
  t.after(() =>
    rmSync(path.join(path.dirname(repo), ".ao-worktrees", "decline-test"), {
      recursive: true,
      force: true,
    })
  );
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  const { session } = await openWorkspaceSession({
    cwd: repo,
    runId: "decline-test",
    isolation: {},
    log: () => {},
  });
  assert.ok(session);
  writeFileSync(path.join(session.reviewDir, "sample.txt"), "discarded\n", "utf8");

  const review = await finalizeWorkspaceReview(session, () => {});
  await declineWorkspaceReview(review);
  assert.equal(readFileSync(path.join(repo, "sample.txt"), "utf8"), "before\n");
});

test("node worktree integrates into review branch, not base", async (t) => {
  const repo = makeRepo();
  const runId = "node-test";
  t.after(() =>
    rmSync(path.join(path.dirname(repo), ".ao-worktrees", runId), {
      recursive: true,
      force: true,
    })
  );
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  const { session } = await openWorkspaceSession({
    cwd: repo,
    runId,
    isolation: {},
    log: () => {},
  });
  const worktree = await createWorktree(session, "node-1", () => {});
  writeFileSync(path.join(worktree.dir, "from-agent.txt"), "new file\n", "utf8");
  const integrated = await integrateWorktree(session, worktree, {
    title: "test node",
    agentFailed: false,
    log: () => {},
  });
  assert.equal(integrated.ok, true);
  assert.equal(readFileSync(path.join(repo, "sample.txt"), "utf8"), "before\n");

  const review = await finalizeWorkspaceReview(session, () => {});
  assert.equal(review.status, "pending");
  assert.equal(review.files[0].path, "from-agent.txt");
  await declineWorkspaceReview(review);
});

test("dirty repositories are rejected before an agent can modify them", async (t) => {
  const repo = makeRepo();
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  writeFileSync(path.join(repo, "unfinished.txt"), "user work\n", "utf8");
  const messages = [];

  const { session, fatal, reason } = await openWorkspaceSession({
    cwd: repo,
    runId: "dirty-test",
    isolation: {},
    log: (message) => messages.push(message),
  });

  assert.equal(session, null);
  // Fatal: the caller must stop rather than edit files it can neither isolate nor roll back.
  assert.equal(fatal, true);
  assert.match(reason, /commit hoặc stash/);
  assert.match(messages.join("\n"), /commit hoặc stash/);
});

test("a non-git directory degrades to a plain run instead of failing it", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "ao-plain-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const { session, fatal, reason } = await openWorkspaceSession({
    cwd: dir,
    runId: "plain-test",
    isolation: {},
    log: () => {},
  });

  assert.equal(session, null);
  // Not fatal: there is nothing to review against and nothing to protect, so the run proceeds
  // in the working directory rather than being refused outright.
  assert.equal(fatal, false);
  assert.match(reason, /git repository/);
});

test("reopening the same run keeps the work already committed to its review branch", async (t) => {
  const repo = makeRepo();
  const runId = "resume-test";
  t.after(() =>
    rmSync(path.join(path.dirname(repo), ".ao-worktrees", runId), { recursive: true, force: true })
  );
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  const first = await openWorkspaceSession({ cwd: repo, runId, isolation: {}, log: () => {} });
  const worktree = await createWorktree(first.session, "node-1", () => {});
  writeFileSync(path.join(worktree.dir, "step-one.txt"), "done before the crash\n", "utf8");
  await integrateWorktree(first.session, worktree, { title: "step one", agentFailed: false, log: () => {} });

  // Simulates a resume after the server died mid-run: same runId, session opened again from
  // scratch. The checkpoint would still call step one "done", so its file has to survive.
  const second = await openWorkspaceSession({ cwd: repo, runId, isolation: {}, log: () => {} });
  assert.ok(second.session);
  assert.equal(second.session.baseCommit, first.session.baseCommit);
  assert.equal(readFileSync(path.join(second.session.reviewDir, "step-one.txt"), "utf8").replaceAll("\r\n", "\n"), "done before the crash\n");

  const review = await finalizeWorkspaceReview(second.session, () => {});
  assert.equal(review.status, "pending");
  assert.deepEqual(review.files.map((f) => f.path), ["step-one.txt"]);
  await declineWorkspaceReview(review);
});

test("gitignored dependencies are reachable from the worktree", async (t) => {
  const repo = makeRepo();
  const runId = "deps-test";
  t.after(() =>
    rmSync(path.join(path.dirname(repo), ".ao-worktrees", runId), { recursive: true, force: true })
  );
  t.after(() => rmSync(repo, { recursive: true, force: true }));

  writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n", "utf8");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "add gitignore");
  mkdirSync(path.join(repo, "node_modules", "left-pad"), { recursive: true });
  writeFileSync(path.join(repo, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n", "utf8");

  const { session } = await openWorkspaceSession({ cwd: repo, runId, isolation: {}, log: () => {} });
  assert.ok(session);
  // Without this an agent asked to "run the tests" finds no dependencies at all.
  assert.ok(existsSync(path.join(session.reviewDir, "node_modules", "left-pad", "index.js")));

  const worktree = await createWorktree(session, "node-1", () => {});
  assert.ok(existsSync(path.join(worktree.dir, "node_modules", "left-pad", "index.js")));

  // Linked-in artefacts stay ignored, so they must never show up as changes to review.
  writeFileSync(path.join(worktree.dir, "tracked.txt"), "real change\n", "utf8");
  await integrateWorktree(session, worktree, { title: "node", agentFailed: false, log: () => {} });
  const review = await finalizeWorkspaceReview(session, () => {});
  assert.deepEqual(review.files.map((f) => f.path), ["tracked.txt"]);
  await declineWorkspaceReview(review);
});
