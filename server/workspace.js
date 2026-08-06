/**
 * Dynamic Workspace Manager — git-worktree isolation for parallel workflow branches.
 *
 * Problem it solves: when a workflow node fans out, every parallel agent used to be spawned
 * with the same `cwd`. Two agents editing the same file at the same time just clobber each
 * other, and there's no point afterwards where you can tell which write won.
 *
 * What this does instead: each parallel agent gets its own `git worktree` (its own directory,
 * its own throwaway branch, sharing the repo's object store so setup is cheap). The agent
 * works there in complete isolation. Once the batch finishes we, per branch and strictly
 * sequentially: commit whatever the agent changed, run the workflow's test command inside
 * that worktree, and only merge back into the base branch if it passed. Then the worktree is
 * removed. A failing test or a merge conflict leaves the worktree on disk (opt-out) so you
 * can go look at it.
 *
 * Everything here is best-effort and reports through the `log` callback the caller passes in
 * — this module deliberately knows nothing about runs/tasks/events.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { spawn as nodeSpawn } from "node:child_process";
import crossSpawn from "cross-spawn";

// Worktrees are created as a *sibling* of the repo, never inside it: a directory inside the
// working tree would show up in the repo's own `git status` (and in the agents' file listings)
// as a giant untracked blob. Sibling keeps it off the repo but on the same filesystem/drive,
// which matters on Windows.
const WORKTREE_DIRNAME = ".ao-worktrees";

// Agents can legitimately take a while; tests even more so. These are just backstops against a
// command that hangs forever holding the whole run hostage.
const GIT_TIMEOUT_MS = 60_000;
const DEFAULT_TEST_TIMEOUT_MS = 15 * 60_000;

/** Runs a command and buffers its combined output. `shell: true` for the user-supplied test
 * command (it's a command *line*, e.g. `npm test -- --run`, not an argv array).
 *
 * Deliberately NOT cross-spawn on the shell path: on Windows cross-spawn can't resolve the
 * executable itself when a shell is involved, and its ENOENT heuristic then turns *any* exit
 * code 1 into a fake `spawn <cmd> ENOENT` error event — i.e. every ordinary failing test suite
 * would be reported as "command not found" instead of showing its real output. Node's own
 * spawn has no such heuristic. cross-spawn is still the right call for `git`, where its
 * PATHEXT/argv-quoting fixes are what we actually want. */
function runCommand(cmd, args, { cwd, shell = false, timeout = GIT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const spawnFn = shell ? nodeSpawn : crossSpawn;
    const child = spawnFn(cmd, args, { cwd, shell, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const append = (chunk) => {
      out += chunk.toString();
      // Keep the tail only — a chatty test suite shouldn't be able to balloon a run's log.
      if (out.length > 20_000) out = out.slice(-20_000);
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, output: `${out}\n${err.message}`.trim() });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) out += `\n[hết thời gian chờ sau ${Math.round(timeout / 1000)}s — tiến trình đã bị kill]`;
      resolve({ ok: !timedOut && code === 0, code, output: out.trim() });
    });
  });
}

const git = (args, cwd, timeout) => runCommand("git", args, { cwd, timeout });

/** Resolves `cwd` to the root of the git repo containing it, or null if it isn't in one. */
async function resolveRepo(cwd) {
  const top = await git(["rev-parse", "--show-toplevel"], cwd);
  if (!top.ok) return null;
  const root = top.output.split("\n")[0].trim();
  if (!root) return null;
  const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], root);
  return { root: path.resolve(root), branch: head.ok ? head.output.trim() : "HEAD" };
}

/** True when the repo has staged/unstaged/untracked changes. Merging into a dirty base is
 * what produces "Your local changes would be overwritten" halfway through a batch, so the
 * caller warns about this up front rather than mid-merge. */
async function isDirty(repoRoot) {
  const res = await git(["status", "--porcelain"], repoRoot);
  return res.ok && res.output.length > 0;
}

/**
 * Prepares isolation for one workflow run. Returns null (with an explanatory log line) when
 * isolation can't apply — not a git repo, or git itself is unavailable — so the caller can
 * transparently fall back to the shared working directory instead of failing the run.
 */
async function openWorkspaceSession({ cwd, runId, isolation, log }) {
  const repo = await resolveRepo(cwd);
  if (!repo) {
    log(
      `⚠️ Bỏ qua cách ly worktree: "${cwd}" không nằm trong một git repository (hoặc không tìm thấy lệnh git). Các nhánh song song sẽ dùng chung thư mục làm việc như trước.`
    );
    return null;
  }
  if (await isDirty(repo.root)) {
    log(
      `⚠️ Repo "${repo.root}" đang có thay đổi chưa commit. Worktree vẫn được tạo từ HEAD, nhưng bước gộp nhánh có thể thất bại vì đụng các file đang sửa dở — nên commit/stash trước khi chạy.`
    );
  }
  return {
    repoRoot: repo.root,
    baseBranch: repo.branch,
    runId,
    testCommand: (isolation?.testCommand || "").trim(),
    keepOnFailure: isolation?.keepOnFailure !== false,
    // repoRoot's parent — see WORKTREE_DIRNAME.
    rootDir: path.join(path.dirname(repo.root), WORKTREE_DIRNAME, runId),
  };
}

/**
 * `git worktree add` for one node: a fresh branch off HEAD checked out in its own directory.
 * Returns null on failure — the caller then runs that node in the shared cwd rather than
 * dropping it, so a worktree problem degrades the isolation guarantee instead of the run.
 */
async function createWorktree(session, nodeId, log) {
  const branch = `ao/${session.runId}/${nodeId}`;
  const dir = path.join(session.rootDir, nodeId);
  try {
    mkdirSync(session.rootDir, { recursive: true });
  } catch {
    /* `git worktree add` will report the real problem below */
  }
  // A leftover directory from a previous crashed run would make `worktree add` refuse.
  if (existsSync(dir)) {
    await git(["worktree", "remove", "--force", dir], session.repoRoot);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  await git(["branch", "-D", branch], session.repoRoot); // no-op if it doesn't exist

  const res = await git(["worktree", "add", "-b", branch, dir, "HEAD"], session.repoRoot);
  if (!res.ok) {
    log(`⚠️ Không tạo được worktree cho bước này (${res.output || "git worktree add thất bại"}). Bước sẽ chạy trên thư mục dùng chung.`);
    return null;
  }
  log(`🌱 Không gian làm việc riêng: ${dir}\n   nhánh tạm: ${branch} (tách từ ${session.baseBranch})`);
  return { branch, dir, nodeId };
}

/** Stages and commits everything the agent touched. `hasChanges:false` means the agent didn't
 * write anything — nothing to test, nothing to merge, worktree can just go away. */
async function commitWorktree(session, wt, message, log) {
  const status = await git(["status", "--porcelain"], wt.dir);
  if (!status.output) {
    log("ℹ️ Agent không thay đổi file nào trong không gian riêng — bỏ qua bước test & gộp nhánh.");
    return { ok: true, hasChanges: false };
  }
  const add = await git(["add", "-A"], wt.dir);
  if (!add.ok) return { ok: false, hasChanges: true, output: add.output };
  // -c user.*: a machine running this may have no global git identity configured, and we don't
  // want that to be the thing that sinks an otherwise-successful agent run.
  const commit = await git(
    ["-c", "user.name=Agents Orchestrator", "-c", "user.email=orchestrator@local", "commit", "-m", message],
    wt.dir
  );
  if (!commit.ok) return { ok: false, hasChanges: true, output: commit.output };
  log(`📦 Đã commit thay đổi của bước này vào nhánh tạm ${wt.branch}.`);
  return { ok: true, hasChanges: true };
}

/** Runs the workflow's test command inside the worktree. No command configured = auto-pass. */
async function runTests(session, wt, log) {
  if (!session.testCommand) return { ok: true, skipped: true };
  log(`🧪 Chạy kiểm thử trong không gian riêng: ${session.testCommand}`);
  const res = await runCommand(session.testCommand, [], {
    cwd: wt.dir,
    shell: true,
    timeout: DEFAULT_TEST_TIMEOUT_MS,
  });
  log(res.output ? `${res.ok ? "🧪" : "❌"} Kết quả kiểm thử:\n${res.output}` : "");
  return { ok: res.ok, skipped: false };
}

/** Merges the node's branch back into the base branch. Conflicts are aborted (leaving the base
 * branch exactly as it was) and reported — resolving them automatically would mean guessing
 * which parallel agent was right. */
async function mergeBack(session, wt, log) {
  const res = await git(
    ["merge", "--no-ff", "--no-edit", "-m", `orchestrator: gộp ${wt.branch}`, wt.branch],
    session.repoRoot
  );
  if (res.ok) {
    log(`✅ Đã gộp ${wt.branch} vào ${session.baseBranch}.`);
    return { ok: true };
  }
  await git(["merge", "--abort"], session.repoRoot);
  log(
    `❌ Gộp nhánh ${wt.branch} vào ${session.baseBranch} bị xung đột — đã huỷ merge, nhánh chính giữ nguyên.\n${res.output}\n` +
      `   Nhánh tạm vẫn còn: tự giải quyết bằng \`git merge ${wt.branch}\` trong ${session.repoRoot}.`
  );
  return { ok: false };
}

/** Removes the worktree directory and deletes its temp branch. Kept (with the path logged) when
 * `keep` is set — that's the "leave the failure around so a human can inspect it" path. */
async function cleanupWorktree(session, wt, { keep, log }) {
  if (keep) {
    log(`🔎 Giữ lại không gian riêng để kiểm tra: ${wt.dir} (nhánh ${wt.branch}).`);
    return;
  }
  const res = await git(["worktree", "remove", "--force", wt.dir], session.repoRoot);
  if (!res.ok) {
    try {
      rmSync(wt.dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    await git(["worktree", "prune"], session.repoRoot);
  }
  await git(["branch", "-D", wt.branch], session.repoRoot);
  log(`🧹 Đã dọn dẹp không gian riêng và nhánh tạm ${wt.branch}.`);
}

/**
 * The full post-run pipeline for ONE isolated node: commit → test → merge → clean up.
 * Returns `{ ok }`; `ok:false` means the node's work did NOT land on the base branch (test
 * failure, merge conflict, or a git error), which the caller turns into a failed node so
 * downstream steps are skipped rather than continuing on work that was silently dropped.
 *
 * Callers MUST await these one at a time: `git merge` takes the repo's index lock, and two
 * concurrent merges into the same base branch would either fail on the lock or interleave.
 */
async function integrateWorktree(session, wt, { title, agentFailed, log }) {
  if (agentFailed) {
    await cleanupWorktree(session, wt, { keep: session.keepOnFailure, log });
    return { ok: false };
  }

  const committed = await commitWorktree(session, wt, `orchestrator: ${title}`.slice(0, 200), log);
  if (!committed.ok) {
    log(`❌ Không commit được thay đổi trong không gian riêng: ${committed.output || "lỗi git"}`);
    await cleanupWorktree(session, wt, { keep: session.keepOnFailure, log });
    return { ok: false };
  }
  if (!committed.hasChanges) {
    await cleanupWorktree(session, wt, { keep: false, log });
    return { ok: true };
  }

  const tested = await runTests(session, wt, log);
  if (!tested.ok) {
    log("❌ Kiểm thử thất bại — KHÔNG gộp nhánh này vào nhánh chính.");
    await cleanupWorktree(session, wt, { keep: session.keepOnFailure, log });
    return { ok: false };
  }

  const merged = await mergeBack(session, wt, log);
  await cleanupWorktree(session, wt, { keep: merged.ok ? false : session.keepOnFailure, log });
  return { ok: merged.ok };
}

/** Last-resort sweep at the end of a run: anything still registered under this run's worktree
 * root (e.g. a node that errored in a way that skipped its own cleanup) gets pruned. Never
 * touches worktrees that `integrateWorktree` deliberately kept — those are passed in as `keep`. */
async function closeWorkspaceSession(session, keptDirs = []) {
  if (!session) return;
  await git(["worktree", "prune"], session.repoRoot);
  if (!keptDirs.length) {
    try {
      rmSync(session.rootDir, { recursive: true, force: true });
    } catch {
      /* the directory may legitimately still hold kept worktrees, or be gone already */
    }
  }
}

export { openWorkspaceSession, createWorktree, integrateWorktree, closeWorkspaceSession };
