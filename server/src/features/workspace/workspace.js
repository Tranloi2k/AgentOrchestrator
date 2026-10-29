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

const DIFF_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Git output that is data, not a log: stdout only (stderr warnings such as "LF will be replaced
 * by CRLF" must not end up inside a patch), kept from the start, and with paths unquoted so
 * names with spaces or Vietnamese characters match across --name-status, --numstat and the patch.
 */
function gitData(args, cwd) {
  return new Promise((resolve) => {
    const child = crossSpawn("git", ["-c", "core.quotePath=false", ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    let size = 0;
    let err = "";
    child.stdout.on("data", (c) => {
      if (size < DIFF_MAX_BYTES) chunks.push(c);
      size += c.length;
    });
    child.stderr.on("data", (c) => (err += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), GIT_TIMEOUT_MS);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, output: e.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString("utf8");
      resolve({ ok: code === 0, output: code === 0 ? output : err.trim() || output, truncated: size > DIFF_MAX_BYTES });
    });
  });
}

/**
 * Splits a whole-range patch into one section per file. git writes the sections in the same order
 * as --name-status lists the files (same range, same options), so they're matched by position;
 * a section is only trusted if its header names the file, otherwise it's looked up by name.
 */
function splitPatchByFile(patch, files) {
  const sections = patch.split(/(?=^diff --git )/m).filter((s) => s.startsWith("diff --git "));
  const names = (file) => [file.path, file.previousPath].filter(Boolean);
  const mentions = (section, file) => {
    const header = section.split("\n", 1)[0];
    return names(file).some((p) => header.includes(` b/${p}`) || header.includes(` a/${p}`));
  };
  return files.map((file, i) => (sections[i] && mentions(sections[i], file) ? sections[i] : sections.find((s) => mentions(s, file)) || ""));
}

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

/** Our own scratch branches (review / per-node) — never offered as a target. */
const isInternalBranch = (name) => name.startsWith("ao/");

/**
 * Local branches of the repo containing `cwd`, for the "target branch" picker. null when
 * `cwd` isn't in a git repo (the run then writes straight into the folder, no review).
 */
async function listBranches(cwd) {
  const repo = await resolveRepo(cwd);
  if (!repo) return null;
  const res = await git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], repo.root);
  const branches = res.ok
    ? res.output.split("\n").map((b) => b.trim()).filter((b) => b && !isInternalBranch(b))
    : [];
  return { repoRoot: repo.root, current: repo.branch, branches };
}

async function branchExists(repoRoot, branch) {
  return (await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repoRoot)).ok;
}

/**
 * Settles which branch a run's work lands on, before the run starts: an existing branch, or a
 * new one created right now from `from`. Throws with a readable message on a bad name, a missing
 * branch or a name that's taken. Returns the branch name, or null when `cwd` isn't a git repo.
 */
async function prepareTargetBranch(cwd, { branch, newBranch }) {
  const repo = await resolveRepo(cwd);
  if (!repo) {
    if (branch || newBranch) throw new Error(`"${cwd}" không phải git repository nên không chọn nhánh được.`);
    return null;
  }
  const from = String(branch || repo.branch).trim();
  if (isInternalBranch(from) || !(await branchExists(repo.root, from))) throw new Error(`Không tìm thấy nhánh "${from}".`);
  const name = String(newBranch || "").trim();
  if (!name) return from;

  const valid = await git(["check-ref-format", "--branch", name], repo.root);
  if (!valid.ok || isInternalBranch(name)) throw new Error(`Tên nhánh "${name}" không hợp lệ.`);
  if (await branchExists(repo.root, name)) throw new Error(`Nhánh "${name}" đã tồn tại — chọn nó trong danh sách thay vì tạo mới.`);
  const created = await git(["branch", name, from], repo.root);
  if (!created.ok) throw new Error(`Không tạo được nhánh "${name}": ${created.output}`);
  return name;
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
async function openWorkspaceSession({ cwd, runId, isolation, targetBranch = null, log }) {
  const repo = await resolveRepo(cwd);
  if (!repo) {
    const reason = `"${cwd}" không nằm trong một git repository (hoặc không tìm thấy lệnh git), nên không tạo được bản review. Agent sẽ ghi thẳng vào thư mục làm việc như trước.`;
    log(`⚠️ ${reason}`);
    return { session: null, fatal: false, reason };
  }
  // The branch the work lands on: the one picked for the run, else whatever is checked out.
  const baseBranch = targetBranch || repo.branch;
  if (targetBranch && !(await branchExists(repo.root, targetBranch))) {
    const reason = `Nhánh đích "${targetBranch}" không còn tồn tại trong repo.`;
    log(`❌ ${reason}`);
    return { session: null, fatal: true, reason };
  }
  // Uncommitted changes only get in the way when the work lands on the checked-out branch: that's
  // where Accept merges into the working files. Another branch is merged off to the side.
  if (baseBranch === repo.branch && (await isDirty(repo.root))) {
    const reason = `Repo "${repo.root}" đang có thay đổi chưa commit. Hãy commit hoặc stash trước khi chạy, để hệ thống tách được chính xác thay đổi của agent và Decline an toàn.`;
    log(`❌ ${reason}`);
    return { session: null, fatal: true, reason };
  }
  const rootDir = path.join(path.dirname(repo.root), WORKTREE_DIRNAME, runId);
  const reviewDir = path.join(rootDir, "review");
  const reviewBranch = `ao/review-${runId}`;
  const headResult = await git(["rev-parse", `refs/heads/${baseBranch}^{commit}`], repo.root);
  if (!headResult.ok) {
    const reason = `Không đọc được nhánh ${baseBranch} của repo "${repo.root}": ${headResult.output || "lỗi git"}`;
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
  const reviewBranchExists = (
    await git(["rev-parse", "--verify", "--quiet", `refs/heads/${reviewBranch}`], repo.root)
  ).ok;
  let baseCommit = headCommit;

  if (reviewBranchExists) {
    const forkPoint = await git(["merge-base", `refs/heads/${baseBranch}`, reviewBranch], repo.root);
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
      baseBranch,
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

/**
 * A Team coordinator's worktree, picked back up when its run is resumed. Members write into the
 * coordinator's folder, so this is where the work items they already finished live; a resumed
 * coordinator is told those items are done, and has to find their files. So when the node's
 * branch from the earlier attempt still exists, it is reused: the folder as it is (a crash leaves
 * it there), or checked out again from the branch (a stop parks it there, see parkWorktree).
 * Anything left uncommitted is committed first, so a later reset can't drop it.
 * Without an earlier branch this is createWorktree. Returns null when the old branch can't be
 * opened: the caller stops rather than silently starting from scratch.
 */
async function reopenWorktree(session, nodeId, log) {
  const branch = `ao/${session.runId}/${nodeId}`;
  const dir = path.join(session.rootDir, "nodes", nodeId);
  if (!(await branchExists(session.repoRoot, branch))) return createWorktree(session, nodeId, log);
  return reuseBranchWorktree(session, { branch, dir, nodeId }, log);
}

/**
 * The worktree of one Team work item (see team-calls.js): its own branch, forked from `fromBranch`
 * (the coordinator's branch) on the item's first call and reused, folder and all, for its fix
 * rounds and after a resume. `key` must be safe in a path and a branch name.
 */
async function openItemWorktree(session, key, fromBranch, log) {
  const branch = `ao/${session.runId}/wi-${key}`;
  const dir = path.join(session.rootDir, "items", key);
  if (await branchExists(session.repoRoot, branch)) return reuseBranchWorktree(session, { branch, dir, nodeId: `wi-${key}` }, log);
  try {
    mkdirSync(path.dirname(dir), { recursive: true });
  } catch {
    /* `git worktree add` will report the real problem below */
  }
  if (existsSync(dir)) {
    await git(["worktree", "remove", "--force", dir], session.repoRoot);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  const res = await git(["worktree", "add", "-b", branch, dir, fromBranch], session.repoRoot);
  if (!res.ok) {
    log(`⚠️ Không tạo được worktree cho công việc này (${res.output || "git worktree add thất bại"}).`);
    return null;
  }
  await linkIgnoredArtifacts(session.repoRoot, dir, log);
  log(`🌱 Không gian làm việc riêng của công việc: ${dir}\n   nhánh: ${branch} (tách từ ${fromBranch})`);
  return { branch, dir, nodeId: `wi-${key}` };
}

/** Opens an existing branch's worktree again: the folder as it is, or checked out afresh. */
async function reuseBranchWorktree(session, { branch, dir, nodeId }, log) {
  let reusable = false;
  if (existsSync(path.join(dir, ".git"))) {
    const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], dir);
    reusable = head.ok && head.output.trim() === branch;
  }
  if (!reusable) {
    await git(["worktree", "remove", "--force", dir], session.repoRoot);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* git reports a useful error below */
    }
    await git(["worktree", "prune"], session.repoRoot);
    const res = await git(["worktree", "add", dir, branch], session.repoRoot);
    if (!res.ok) {
      log(`❌ Không mở lại được không gian làm việc của lần chạy trước (${res.output || "git worktree add thất bại"}).`);
      return null;
    }
    await linkIgnoredArtifacts(session.repoRoot, dir, log);
  }
  const wt = { branch, dir, nodeId };
  await commitWorktree(session, wt, "orchestrator: giữ lại công việc của lần chạy bị gián đoạn", log);
  log(`♻️ Dùng lại không gian làm việc của lần chạy trước: ${dir} (nhánh ${branch}); công việc đã xong vẫn còn.`);
  return wt;
}

/**
 * Keeps a stopped or failed Team coordinator's worktree for a resume instead of discarding it:
 * its changes are committed on its own branch, and the folder and branch stay (reopenWorktree
 * picks them up). Nothing is tested or merged into the review.
 */
async function parkWorktree(session, wt, log) {
  const committed = await commitWorktree(session, wt, `orchestrator: ${wt.nodeId} (tạm dừng, chờ chạy tiếp)`, log);
  if (!committed.ok) {
    log(`⚠️ Không commit được không gian làm việc để chạy tiếp: ${committed.output || "lỗi git"}. Thư mục vẫn được giữ: ${wt.dir}`);
    return false;
  }
  log(`⏸️ Giữ lại không gian làm việc và nhánh ${wt.branch} để "Chạy tiếp" dùng lại công việc đã xong (chưa gộp vào review).`);
  return true;
}

/**
 * Puts a node's worktree back to where it started (its branch's last commit), dropping a failed
 * attempt's edits so a retry starts clean. Ignored files — the linked node_modules etc. — stay.
 */
async function resetWorktree(wt, log) {
  const reset = await git(["reset", "--hard", "HEAD"], wt.dir);
  const clean = await git(["clean", "-fd"], wt.dir);
  if (!reset.ok || !clean.ok) log(`⚠️ Không dọn được thay đổi của lần thử trước: ${reset.output || clean.output}`);
  else log("🧹 Đã dọn thay đổi của lần thử trước.");
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

/** Where a worktree is merged by default: the run's review worktree. */
const reviewTarget = (session) => ({ dir: session.reviewDir, branch: session.reviewBranch, label: "workspace review" });

/** True when the worktree's branch has commits the target branch (the review by default) doesn't. */
async function hasUnmergedCommits(session, wt, targetBranch = session.reviewBranch) {
  const res = await git(["rev-list", "--count", `${targetBranch}..${wt.branch}`], session.repoRoot);
  return res.ok && Number(res.output.trim()) > 0;
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
async function mergeBack(session, wt, log, target = reviewTarget(session)) {
  const res = await git(
    ["merge", "--no-ff", "--no-edit", "-m", `orchestrator: gộp ${wt.branch}`, wt.branch],
    target.dir
  );
  if (res.ok) {
    log(`✅ Đã gộp ${wt.branch} vào ${target.label}.`);
    return { ok: true };
  }
  await git(["merge", "--abort"], target.dir);
  log(
    `❌ Gộp nhánh ${wt.branch} vào ${target.label} bị xung đột — đã huỷ merge, nhánh ${session.baseBranch} vẫn giữ nguyên.\n${res.output}\n` +
      `   Nhánh tạm vẫn còn: tự giải quyết bằng \`git merge ${wt.branch}\` trong ${target.dir}.`
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
async function integrateWorktree(session, wt, { title, agentFailed, log, into = null }) {
  const target = into || reviewTarget(session);
  if (agentFailed) {
    await cleanupWorktree(session, wt, { keep: session.keepOnFailure, log });
    return { ok: false, reason: "agent_failed" };
  }

  const committed = await commitWorktree(session, wt, `orchestrator: ${title}`.slice(0, 200), log);
  if (!committed.ok) {
    log(`❌ Không commit được thay đổi trong không gian riêng: ${committed.output || "lỗi git"}`);
    await cleanupWorktree(session, wt, { keep: session.keepOnFailure, log });
    return { ok: false, reason: "commit_failed" };
  }
  // Nothing new to commit can still mean work to merge: a reopened Team coordinator's branch
  // already carries the commits of its interrupted attempts (see reopenWorktree).
  if (!committed.hasChanges && !(await hasUnmergedCommits(session, wt, target.branch))) {
    await cleanupWorktree(session, wt, { keep: false, log });
    return { ok: true, reason: "no_changes" };
  }

  const tested = await runTests(session, wt, log);
  if (!tested.ok) {
    log("❌ Kiểm thử thất bại — KHÔNG gộp nhánh này vào nhánh chính.");
    await cleanupWorktree(session, wt, { keep: session.keepOnFailure, log });
    return { ok: false, reason: "tests_failed" };
  }

  const merged = await mergeBack(session, wt, log, target);
  await cleanupWorktree(session, wt, { keep: merged.ok ? false : session.keepOnFailure, log });
  return { ok: merged.ok, reason: merged.ok ? "merged" : "conflict" };
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
    gitData(["diff", "--name-status", "--find-renames", range], session.reviewDir),
    gitData(["diff", "--numstat", "--find-renames", range], session.reviewDir),
    gitData(["diff", "--no-color", "--find-renames", range], session.reviewDir),
  ]);
  if (!nameStatus.ok || !numstat.ok || !patch.ok) {
    throw new Error(nameStatus.output || numstat.output || patch.output || "Không đọc được diff");
  }

  const files = parseReviewFiles(nameStatus.output, numstat.output);
  if (!files.length) {
    await cleanupReviewWorkspace(session);
    return { status: "no_changes", files: [], patch: "", patchTruncated: false };
  }

  // Each file carries its own section of the patch, capped per file so one huge file (a lock
  // file, a build output) can't push every other file's diff out.
  const perFileMax = 400_000;
  const sections = splitPatchByFile(patch.output, files);
  files.forEach((file, i) => {
    file.patch = sections[i].slice(0, perFileMax);
    file.patchTruncated = sections[i].length > perFileMax || (patch.truncated && !sections[i]);
  });
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
    patchTruncated: !!patch.truncated,
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
  if (!(await branchExists(review.repoRoot, review.baseBranch))) {
    throw new Error(`Nhánh đích "${review.baseBranch}" không còn tồn tại.`);
  }

  // Merge where the target branch is checked out (the repo itself or another worktree) so those
  // files update; if it isn't checked out anywhere, in a temporary worktree next to the review.
  let mergeDir = await checkedOutAt(review.repoRoot, review.baseBranch);
  let temporary = false;
  if (mergeDir) {
    if (await isDirty(mergeDir)) {
      throw new Error(`Nhánh ${review.baseBranch} đang được checkout ở "${mergeDir}" và có thay đổi chưa commit. Commit hoặc stash rồi Accept lại.`);
    }
  } else {
    mergeDir = path.join(path.dirname(review.dir), "land");
    rmSync(mergeDir, { recursive: true, force: true });
    const added = await git(["worktree", "add", mergeDir, review.baseBranch], review.repoRoot);
    if (!added.ok) throw new Error(`Không mở được nhánh ${review.baseBranch} để gộp: ${added.output}`);
    temporary = true;
  }
  try {
    const merged = await git(["merge", "--no-ff", "--no-edit", "-m", `orchestrator: accept ${review.branch}`, review.branch], mergeDir);
    if (!merged.ok) {
      await git(["merge", "--abort"], mergeDir);
      throw new Error(`Không thể apply thay đổi vào ${review.baseBranch}: ${merged.output || "git merge thất bại"}`);
    }
  } finally {
    if (temporary) {
      await git(["worktree", "remove", "--force", mergeDir], review.repoRoot);
      await git(["worktree", "prune"], review.repoRoot);
    }
  }
  await cleanupReviewWorkspace(review);
}

/** The directory where `branch` is checked out (main repo or any worktree), or null. */
async function checkedOutAt(repoRoot, branch) {
  const res = await git(["worktree", "list", "--porcelain"], repoRoot);
  if (!res.ok) return null;
  let dir = null;
  for (const line of res.output.split("\n")) {
    if (line.startsWith("worktree ")) dir = line.slice("worktree ".length).trim();
    else if (line.trim() === `branch refs/heads/${branch}`) return dir ? path.resolve(dir) : null;
  }
  return null;
}

async function declineWorkspaceReview(review) {
  await cleanupReviewWorkspace(review);
}

export {
  resetWorktree,
  listBranches,
  prepareTargetBranch,
  openWorkspaceSession,
  createWorktree,
  reopenWorktree,
  openItemWorktree,
  parkWorktree,
  integrateWorktree,
  closeWorkspaceSession,
  finalizeWorkspaceReview,
  acceptWorkspaceReview,
  declineWorkspaceReview,
};
