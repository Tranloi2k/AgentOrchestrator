import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  openWorkspaceSession,
  createWorktree,
  reopenWorktree,
  parkWorktree,
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

/** A repo with uncommitted work: a modified tracked file, a staged new file, an untracked one. */
function makeDirtyRepo() {
  const repo = makeRepo();
  writeFileSync(path.join(repo, "sample.txt"), "user edit\n", "utf8");
  writeFileSync(path.join(repo, "staged.txt"), "staged by user\n", "utf8");
  git(repo, "add", "staged.txt");
  writeFileSync(path.join(repo, "unfinished.txt"), "user work\n", "utf8");
  return repo;
}
// Checkouts may turn LF into CRLF (core.autocrlf on Windows).
const read = (file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");

test("a run on uncommitted changes builds on them without touching the user's checkout", async (t) => {
  const repo = makeDirtyRepo();
  const runId = "dirty-test";
  t.after(() => rmSync(path.join(path.dirname(repo), ".ao-worktrees", runId), { recursive: true, force: true }));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const statusBefore = git(repo, "status", "--porcelain");
  const headBefore = git(repo, "rev-parse", "HEAD");
  const messages = [];

  const { session, fatal } = await openWorkspaceSession({ cwd: repo, runId, isolation: {}, log: (m) => messages.push(m) });
  assert.ok(session, "the run starts");
  assert.equal(fatal, false);
  assert.match(messages.join("\n"), /chụp lại/);
  // The agents see the user's work in progress.
  assert.equal(read(path.join(session.reviewDir, "sample.txt")), "user edit\n");
  assert.equal(read(path.join(session.reviewDir, "staged.txt")), "staged by user\n");
  assert.equal(read(path.join(session.reviewDir, "unfinished.txt")), "user work\n");
  // ...and the user's checkout, index included, is exactly as it was.
  assert.equal(git(repo, "status", "--porcelain"), statusBefore);
  assert.equal(git(repo, "rev-parse", "HEAD"), headBefore);

  // An agent edits the user's untracked file, adds one, and deletes the staged one.
  writeFileSync(path.join(session.reviewDir, "unfinished.txt"), "user work\nfinished by agent\n", "utf8");
  writeFileSync(path.join(session.reviewDir, "from-agent.txt"), "new\n", "utf8");
  rmSync(path.join(session.reviewDir, "staged.txt"));
  const review = await finalizeWorkspaceReview(session, () => {});
  assert.deepEqual(review.files.map((f) => f.path).sort(), ["from-agent.txt", "staged.txt", "unfinished.txt"], "only the agent's changes are in the review");

  await acceptWorkspaceReview(review);
  assert.equal(git(repo, "rev-parse", "HEAD"), headBefore, "nothing was committed for the user");
  assert.equal(read(path.join(repo, "sample.txt")), "user edit\n", "the user's own edit is still there");
  assert.equal(read(path.join(repo, "unfinished.txt")), "user work\nfinished by agent\n");
  assert.equal(read(path.join(repo, "from-agent.txt")), "new\n");
  assert.ok(!existsSync(path.join(repo, "staged.txt")));
  assert.equal(git(repo, "for-each-ref", "refs/ao/"), "", "the snapshot ref is gone");
});

test("Accept refuses, writing nothing, when the user changed a file the agent also changed", async (t) => {
  const repo = makeDirtyRepo();
  const runId = "dirty-conflict";
  t.after(() => rmSync(path.join(path.dirname(repo), ".ao-worktrees", runId), { recursive: true, force: true }));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const { session } = await openWorkspaceSession({ cwd: repo, runId, isolation: {}, log: () => {} });
  writeFileSync(path.join(session.reviewDir, "unfinished.txt"), "agent version\n", "utf8");
  writeFileSync(path.join(session.reviewDir, "other.txt"), "agent file\n", "utf8");
  const review = await finalizeWorkspaceReview(session, () => {});

  writeFileSync(path.join(repo, "unfinished.txt"), "user kept editing\n", "utf8");
  await assert.rejects(() => acceptWorkspaceReview(review), /unfinished\.txt/);
  assert.equal(read(path.join(repo, "unfinished.txt")), "user kept editing\n");
  assert.ok(!existsSync(path.join(repo, "other.txt")), "not even the files without a clash were written");

  await declineWorkspaceReview(review);
  assert.equal(read(path.join(repo, "unfinished.txt")), "user kept editing\n");
  assert.equal(git(repo, "for-each-ref", "refs/ao/"), "");
});

test("a resumed run on uncommitted changes keeps diffing against its snapshot", async (t) => {
  const repo = makeDirtyRepo();
  const runId = "dirty-resume";
  t.after(() => rmSync(path.join(path.dirname(repo), ".ao-worktrees", runId), { recursive: true, force: true }));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const first = await openWorkspaceSession({ cwd: repo, runId, isolation: {}, log: () => {} });
  writeFileSync(path.join(first.session.reviewDir, "from-agent.txt"), "new\n", "utf8");
  git(first.session.reviewDir, "add", "-A");
  git(first.session.reviewDir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "agent");

  const second = await openWorkspaceSession({ cwd: repo, runId, isolation: {}, log: () => {} });
  assert.equal(second.session.baseCommit, first.session.baseCommit);
  const review = await finalizeWorkspaceReview(second.session, () => {});
  assert.deepEqual(review.files.map((f) => f.path), ["from-agent.txt"]);
  await declineWorkspaceReview(review);
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

test("a team coordinator's worktree survives a crash or a stop and is reopened on resume", async (t) => {
  const repo = makeRepo();
  const runId = "reopen-test";
  t.after(() => rmSync(path.join(path.dirname(repo), ".ao-worktrees", runId), { recursive: true, force: true }));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const { session } = await openWorkspaceSession({ cwd: repo, runId, isolation: {}, log: () => {} });

  // First attempt: a member writes into the coordinator's folder, then the server dies.
  const first = await reopenWorktree(session, "coordinator", () => {});
  writeFileSync(path.join(first.dir, "member-1.txt"), "done by a member\n", "utf8");

  // Resume after the crash: same folder, the member's file is still there and now committed.
  const second = await reopenWorktree(session, "coordinator", () => {});
  assert.equal(second.dir, first.dir, "same folder, so the coordinator's Claude session can be resumed");
  assert.equal(readFileSync(path.join(second.dir, "member-1.txt"), "utf8"), "done by a member\n");
  assert.equal(git(second.dir, "status", "--porcelain"), "");

  // Second attempt is stopped: the worktree is parked, and even with its folder gone a resume
  // checks the work out again from the branch.
  writeFileSync(path.join(second.dir, "member-2.txt"), "also done\n", "utf8");
  assert.equal(await parkWorktree(session, second, () => {}), true);
  git(repo, "worktree", "remove", "--force", second.dir);
  const third = await reopenWorktree(session, "coordinator", () => {});
  assert.ok(existsSync(path.join(third.dir, "member-1.txt")));
  assert.ok(existsSync(path.join(third.dir, "member-2.txt")));

  // Nothing reached the base branch along the way.
  assert.ok(!existsSync(path.join(repo, "member-1.txt")));
  const integrated = await integrateWorktree(session, third, { title: "coordinator", agentFailed: false, log: () => {} });
  assert.equal(integrated.ok, true);
  const review = await finalizeWorkspaceReview(session, () => {});
  assert.deepEqual(review.files.map((f) => f.path).sort(), ["member-1.txt", "member-2.txt"]);
  await declineWorkspaceReview(review);
});
