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

import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
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
 * A worktree only materializes git-*tracked* files, so everything `.gitignore`d — `node_modules`,
 * `.env`, build caches — is simply absent. That breaks the ordinary "run the tests for me" case
 * and makes a workflow's own test command close to unusable, since it would have to reinstall
 * dependencies from scratch on every node of every run.
 *
 * So we link the base repo's top-level ignored entries into the worktree. Junctions on Windows
 * (real symlinks need elevation there; junctions don't) and plain symlinks elsewhere. They stay
 * invisible to git — the same `.gitignore` that named them is itself tracked, so it carries into
 * the worktree and keeps `git add -A` from ever picking them up.
 *
 * These point at the *shared* originals, deliberately: reinstalling per worktree would cost more
 * than the isolation is worth. That means an agent running `npm install` mutates the real
 * `node_modules`, and two parallel agents doing it at once still collide — file isolation is what
 * worktrees buy you, not dependency isolation.
 */
async function linkIgnoredArtifacts(repoRoot, targetDir, log) {
  // --directory collapses an ignored folder to one entry instead of listing every file under it.
  const listed = await git(
    ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"],
    repoRoot
  );
  if (!listed.ok) return;

  const names = new Set();
  for (const raw of listed.output.split("\n")) {
    const entry = raw.trim().replace(/\/$/, "");
    // Top-level only: a nested ignored path (`packages/a/node_modules`) would need its parent
    // directories created first, and those are tracked dirs git will populate itself.
    if (!entry || entry.includes("/") || entry === ".git") continue;
    names.add(entry);
  }

  const linked = [];
  for (const name of [...names].slice(0, 50)) {
    const source = path.join(repoRoot, name);
    const dest = path.join(targetDir, name);
    if (!existsSync(source) || existsSync(dest)) continue;
    try {
      symlinkSync(source, dest, process.platform === "win32" ? "junction" : "dir");
      linked.push(name);
    } catch {
      // Not fatal: a file (rather than directory) entry, or a filesystem/permission that won't
      // take links. The agent just won't see that one artefact.
      try {
        symlinkSync(source, dest, "file");
        linked.push(name);
      } catch {
        /* give up on this entry */
      }
    }
  }
  if (linked.length) {
    log(`🔗 Dùng chung với repo gốc (không được git quản lý): ${linked.join(", ")}`);
  }
}

/**
 * Prepares the review workspace for one run.
 *
 * Always returns `{ session, reason }`. A null `session` means no isolation, and `fatal` says
 * what the caller should do about it:
 *   - `fatal: false` — isolation simply doesn't apply here (not a git repo). The run proceeds in
 *     the shared working directory, exactly as it did before review existed.
 *   - `fatal: true`  — it *should* have applied and didn't (dirty repo, git error). Continuing
 *     would edit files we can't cleanly separate or roll back, so the caller stops the run.
 * `reason` is the message shown to the user, so each failure explains its own specific cause
 * rather than the caller inventing a generic one.
 */
async function openWorkspaceSession({ cwd, runId, isolation, log }) {
  const repo = await resolveRepo(cwd);
  if (!repo) {
    const reason = `"${cwd}" không nằm trong một git repository (hoặc không tìm thấy lệnh git), nên không tạo được bản review. Agent sẽ ghi thẳng vào thư mục làm việc như trước.`;
    log(`⚠️ ${reason}`);
    return { session: null, fatal: false, reason };
  }
  if (await isDirty(repo.root)) {
    const reason = `Repo "${repo.root}" đang có thay đổi chưa commit. Hãy commit hoặc stash trước khi chạy, để hệ thống tách được chính xác thay đổi của agent và Decline an toàn.`;
    log(`❌ ${reason}`);
    return { session: null, fatal: true, reason };
  }
  const rootDir = path.join(path.dirname(repo.root), WORKTREE_DIRNAME, runId);
  const reviewDir = path.join(rootDir, "review");
  const reviewBranch = `ao/review-${runId}`;
  const headResult = await git(["rev-parse", "HEAD"], repo.root);
  if (!headResult.ok) {
    const reason = `Không đọc được HEAD của repo "${repo.root}": ${headResult.output || "lỗi git"}`;
    log(`❌ ${reason}`);
    return { session: null, fatal: true, reason };
  }
  const headCommit = headResult.output.trim();

  try {
    mkdirSync(rootDir, { recursive: true });
  } catch {
    /* git reports a useful error below */
  }
  // Clears registrations whose directory is already gone, so the checks below see the truth.
  await git(["worktree", "prune"], repo.root);

  // A review branch under this run's id already existing means this is a resume (or a restart
  // after a crash). Its commits ARE the work the checkpoint records as done — recreating the
  // branch from HEAD would keep those nodes marked done while silently throwing away every file
  // they wrote. So reuse it, and take the base commit from where it forked rather than from HEAD.
  const branchExists = (
    await git(["rev-parse", "--verify", "--quiet", `refs/heads/${reviewBranch}`], repo.root)
  ).ok;
  let baseCommit = headCommit;

  if (branchExists) {
    const forkPoint = await git(["merge-base", "HEAD", reviewBranch], repo.root);
    if (forkPoint.ok && forkPoint.output.trim()) baseCommit = forkPoint.output.trim();

    // In a worktree `.git` is a file pointing back at the real repo; its absence means the
    // directory was deleted or never finished being created, while the branch survived.
    if (!existsSync(path.join(reviewDir, ".git"))) {
      try {
        rmSync(reviewDir, { recursive: true, force: true });
      } catch {
        /* git reports a useful error below */
      }
      const reattached = await git(["worktree", "add", reviewDir, reviewBranch], repo.root);
      if (!reattached.ok) {
        const reason = `Không mở lại được workspace review của run này: ${reattached.output || "git worktree add thất bại"}`;
        log(`❌ ${reason}`);
        return { session: null, fatal: true, reason };
      }
    }
    log(`♻️ Dùng lại workspace review đã có của run này (nhánh ${reviewBranch}) — thay đổi của các bước đã xong được giữ nguyên.`);
  } else {
    if (existsSync(reviewDir)) {
      await git(["worktree", "remove", "--force", reviewDir], repo.root);
      try {
        rmSync(reviewDir, { recursive: true, force: true });
      } catch {
        /* git reports a useful error below */
      }
    }
    const created = await git(["worktree", "add", "-b", reviewBranch, reviewDir, headCommit], repo.root);
    if (!created.ok) {
      const reason = `Không tạo được workspace review: ${created.output || "git worktree add thất bại"}`;
      log(`❌ ${reason}`);
      return { session: null, fatal: true, reason };
    }
  }

  await linkIgnoredArtifacts(repo.root, reviewDir, log);

  return {
    session: {
      repoRoot: repo.root,
      baseBranch: repo.branch,
      baseCommit,
      reviewBranch,
      reviewDir,
      runId,
      testCommand: isolation?.enabled ? (isolation?.testCommand || "").trim() : "",
      keepOnFailure: isolation?.keepOnFailure !== false,
      // repoRoot's parent — see WORKTREE_DIRNAME.
      rootDir,
    },
    fatal: false,
    reason: "",
  };
}

/**
 * `git worktree add` for one node: a fresh branch off HEAD checked out in its own directory.
 * Returns null on failure — the caller then runs that node in the shared cwd rather than
 * dropping it, so a worktree problem degrades the isolation guarantee instead of the run.
 */
async function createWorktree(session, nodeId, log) {
  const branch = `ao/${session.runId}/${nodeId}`;
  const dir = path.join(session.rootDir, "nodes", nodeId);
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

  const res = await git(
    ["worktree", "add", "-b", branch, dir, session.reviewBranch],
    session.repoRoot
  );
  if (!res.ok) {
    log(`⚠️ Không tạo được worktree cho bước này (${res.output || "git worktree add thất bại"}). Bước sẽ chạy trên thư mục dùng chung.`);
    return null;
  }
  await linkIgnoredArtifacts(session.repoRoot, dir, log);
  log(`🌱 Không gian làm việc riêng: ${dir}\n   nhánh tạm: ${branch} (tách từ workspace review)`);
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
    session.reviewDir
  );
  if (res.ok) {
    log(`✅ Đã gộp ${wt.branch} vào workspace review.`);
    return { ok: true };
  }
  await git(["merge", "--abort"], session.reviewDir);
  log(
    `❌ Gộp nhánh ${wt.branch} vào workspace review bị xung đột — đã huỷ merge, nhánh ${session.baseBranch} vẫn giữ nguyên.\n${res.output}\n` +
      `   Nhánh tạm vẫn còn: tự giải quyết bằng \`git merge ${wt.branch}\` trong ${session.reviewDir}.`
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
  // The review worktree deliberately remains until the user accepts or declines it.
}

function parseReviewFiles(nameStatusOutput, numstatOutput) {
  const counts = new Map();
  for (const line of numstatOutput.split("\n")) {
    if (!line) continue;
    const [added, deleted, ...pathParts] = line.split("\t");
    const filePath = pathParts.at(-1);
    if (filePath) {
      counts.set(filePath, {
        additions: added === "-" ? null : Number(added) || 0,
        deletions: deleted === "-" ? null : Number(deleted) || 0,
      });
    }
  }
  return nameStatusOutput
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [rawStatus, ...paths] = line.split("\t");
      const filePath = paths.at(-1) || "";
      return {
        path: filePath,
        previousPath: paths.length > 1 ? paths[0] : null,
        status: rawStatus[0] || "M",
        ...(counts.get(filePath) || { additions: null, deletions: null }),
      };
    });
}

/** Commits direct edits in the review worktree and freezes a patch for the run history. */
async function finalizeWorkspaceReview(session, log) {
  const committed = await commitWorktree(
    session,
    { branch: session.reviewBranch, dir: session.reviewDir },
    `orchestrator: review ${session.runId}`,
    log
  );
  if (!committed.ok) throw new Error(committed.output || "Không commit được workspace review");

  const range = `${session.baseCommit}...${session.reviewBranch}`;
  const [nameStatus, numstat, patch] = await Promise.all([
    git(["diff", "--name-status", "--find-renames", range], session.reviewDir),
    git(["diff", "--numstat", "--find-renames", range], session.reviewDir),
    git(["diff", "--no-color", "--find-renames", range], session.reviewDir),
  ]);
  if (!nameStatus.ok || !numstat.ok || !patch.ok) {
    throw new Error(nameStatus.output || numstat.output || patch.output || "Không đọc được diff");
  }

  const files = parseReviewFiles(nameStatus.output, numstat.output);
  if (!files.length) {
    await cleanupReviewWorkspace(session);
    return { status: "no_changes", files: [], patch: "", patchTruncated: false };
  }

  const maxPatchLength = 1_500_000;
  const reviewHead = await git(["rev-parse", session.reviewBranch], session.repoRoot);
  if (!reviewHead.ok) throw new Error(reviewHead.output || "Không đọc được review commit");
  return {
    status: "pending",
    repoRoot: session.repoRoot,
    baseBranch: session.baseBranch,
    baseCommit: session.baseCommit,
    branch: session.reviewBranch,
    reviewHead: reviewHead.output.trim(),
    dir: session.reviewDir,
    files,
    patch: patch.output.slice(0, maxPatchLength),
    patchTruncated: patch.output.length > maxPatchLength,
    createdAt: Date.now(),
  };
}

async function cleanupReviewWorkspace(reviewOrSession) {
  const repoRoot = reviewOrSession.repoRoot;
  const dir = reviewOrSession.reviewDir || reviewOrSession.dir;
  const branch = reviewOrSession.reviewBranch || reviewOrSession.branch;
  if (dir) await git(["worktree", "remove", "--force", dir], repoRoot);
  await git(["worktree", "prune"], repoRoot);
  if (branch) await git(["branch", "-D", branch], repoRoot);
}

async function acceptWorkspaceReview(review) {
  const currentReviewHead = await git(["rev-parse", review.branch], review.repoRoot);
  if (!currentReviewHead.ok || currentReviewHead.output.trim() !== review.reviewHead) {
    throw new Error("Nhánh review đã thay đổi sau khi tạo diff. Hãy review lại trước khi Accept.");
  }
  const currentBranch = await git(["rev-parse", "--abbrev-ref", "HEAD"], review.repoRoot);
  if (!currentBranch.ok || currentBranch.output.trim() !== review.baseBranch) {
    throw new Error(`Repo phải đang ở nhánh ${review.baseBranch} để Accept.`);
  }
  const merged = await git(
    ["merge", "--no-ff", "--no-edit", "-m", `orchestrator: accept ${review.branch}`, review.branch],
    review.repoRoot
  );
  if (!merged.ok) {
    await git(["merge", "--abort"], review.repoRoot);
    throw new Error(`Không thể apply thay đổi: ${merged.output || "git merge thất bại"}`);
  }
  await cleanupReviewWorkspace(review);
}

async function declineWorkspaceReview(review) {
  await cleanupReviewWorkspace(review);
}

export {
  openWorkspaceSession,
  createWorktree,
  integrateWorktree,
  closeWorkspaceSession,
  finalizeWorkspaceReview,
  acceptWorkspaceReview,
  declineWorkspaceReview,
};
