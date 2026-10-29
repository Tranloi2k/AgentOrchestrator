import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { listBranches, prepareTargetBranch, openWorkspaceSession, finalizeWorkspaceReview, acceptWorkspaceReview } from "./workspace.js";

// Real git, temporary repos: the run's work must land on the branch picked for it, and nowhere else.
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const noop = () => {};

function makeRepo() {
  const parent = mkdtempSync(path.join(os.tmpdir(), "ao-branch-"));
  const repo = path.join(parent, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "core.autocrlf", "false");
  writeFileSync(path.join(repo, "README.md"), "x\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "init");
  git(repo, "branch", "feature");
  return { parent, repo };
}

async function runOnto(repo, runId, targetBranch, file) {
  const { session } = await openWorkspaceSession({ cwd: repo, runId, isolation: {}, targetBranch, log: noop });
  assert.ok(session, "workspace opened");
  writeFileSync(path.join(session.reviewDir, file), "agent\n");
  const review = await finalizeWorkspaceReview(session, noop);
  assert.equal(review.status, "pending");
  return review;
}

const fileOn = (repo, branch, file) => {
  try {
    return git(repo, "show", `${branch}:${file}`);
  } catch {
    return null;
  }
};

test("work lands on a branch that isn't checked out; the checked-out one is untouched", async () => {
  const { parent, repo } = makeRepo();
  try {
    const listed = await listBranches(repo);
    assert.deepEqual([listed.current, listed.branches.sort()], ["main", ["feature", "main"]]);

    const review = await runOnto(repo, "r1", "feature", "a.txt");
    assert.equal(review.baseBranch, "feature");
    await acceptWorkspaceReview(review);

    assert.equal(fileOn(repo, "feature", "a.txt"), "agent");
    assert.equal(fileOn(repo, "main", "a.txt"), null, "main never sees it");
    assert.equal(git(repo, "rev-parse", "--abbrev-ref", "HEAD"), "main", "the repo stays on main");
    assert.ok(!existsSync(path.join(repo, "a.txt")), "main's working files unchanged");
    assert.ok(!(await listBranches(repo)).branches.some((b) => b.startsWith("ao/")), "scratch branches cleaned up");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("on the checked-out branch, Accept updates the working files", async () => {
  const { parent, repo } = makeRepo();
  try {
    const review = await runOnto(repo, "r2", "main", "b.txt");
    const head = git(repo, "rev-parse", "HEAD");
    await acceptWorkspaceReview(review);
    assert.equal(readFileSync(path.join(repo, "b.txt"), "utf8"), "agent\n");
    assert.notEqual(git(repo, "rev-parse", "HEAD"), head, "a clean checkout gets the merge commit");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("edited while the run worked: Accept writes next to the user's edits, unless a file clashes", async () => {
  const { parent, repo } = makeRepo();
  try {
    const review = await runOnto(repo, "r4", "main", "b.txt");
    const head = git(repo, "rev-parse", "HEAD");
    writeFileSync(path.join(repo, "README.md"), "local edit\n");
    await acceptWorkspaceReview(review);
    assert.equal(readFileSync(path.join(repo, "b.txt"), "utf8").replace(/\r\n/g, "\n"), "agent\n");
    assert.equal(readFileSync(path.join(repo, "README.md"), "utf8"), "local edit\n", "the user's edit is kept");
    assert.equal(git(repo, "rev-parse", "HEAD"), head, "nothing committed over the user's work in progress");

    const clash = await runOnto(repo, "r5", "main", "c.txt");
    writeFileSync(path.join(repo, "c.txt"), "user wrote it too\n");
    await assert.rejects(acceptWorkspaceReview(clash), /c\.txt/);
    assert.equal(readFileSync(path.join(repo, "c.txt"), "utf8"), "user wrote it too\n");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a new branch is created from the chosen one; bad or taken names are refused", async () => {
  const { parent, repo } = makeRepo();
  try {
    git(repo, "checkout", "-q", "feature");
    writeFileSync(path.join(repo, "f.txt"), "feature only\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "feature work");
    git(repo, "checkout", "-q", "main");

    assert.equal(await prepareTargetBranch(repo, { branch: "feature", newBranch: "agent/login" }), "agent/login");
    assert.equal(fileOn(repo, "agent/login", "f.txt"), "feature only", "forked from feature, not main");
    await assert.rejects(prepareTargetBranch(repo, { branch: "main", newBranch: "agent/login" }), /đã tồn tại/);
    await assert.rejects(prepareTargetBranch(repo, { branch: "main", newBranch: "bad name.." }), /không hợp lệ/);
    await assert.rejects(prepareTargetBranch(repo, { branch: "nope" }), /Không tìm thấy/);
    assert.equal(await prepareTargetBranch(repo, {}), "main", "default: the checked-out branch");

    const review = await runOnto(repo, "r3", "agent/login", "c.txt");
    await acceptWorkspaceReview(review);
    assert.equal(fileOn(repo, "agent/login", "c.txt"), "agent");
    assert.equal(fileOn(repo, "feature", "c.txt"), null);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("each changed file gets its own diff, even past 20KB and with spaces / non-ASCII names", async () => {
  const { parent, repo } = makeRepo();
  try {
    const { session } = await openWorkspaceSession({ cwd: repo, runId: "r4", isolation: {}, targetBranch: "main", log: noop });
    const big = Array.from({ length: 3000 }, (_, i) => `line ${i}`).join("\n") + "\n"; // ~30KB
    writeFileSync(path.join(session.reviewDir, "a-big.txt"), big);
    writeFileSync(path.join(session.reviewDir, "màn chơi mới.txt"), "level\n");
    writeFileSync(path.join(session.reviewDir, "z.txt"), "last\n");
    const review = await finalizeWorkspaceReview(session, noop);
    const byPath = Object.fromEntries(review.files.map((f) => [f.path, f]));
    assert.deepEqual(Object.keys(byPath).sort(), ["a-big.txt", "màn chơi mới.txt", "z.txt"]);
    assert.match(byPath["a-big.txt"].patch, /^diff --git a\/a-big\.txt[\s\S]*\+line 2999/);
    assert.match(byPath["màn chơi mới.txt"].patch, /^diff --git a\/màn chơi mới\.txt[\s\S]*\+level$/m);
    assert.match(byPath["z.txt"].patch, /^diff --git a\/z\.txt[\s\S]*\+last/);
    assert.ok(!byPath["z.txt"].patch.includes("line 1"), "no other file's lines in it");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
