/**
 * The server side of `ask_agent`: one node (a Team's coordinator, or any Pipeline node with
 * callees) hands a work item to another node and waits for the answer.
 *
 * A member keeps its context across the rounds of one work item. Every call is recorded on the
 * run's delegation ledger (delegation-policy.js) together with the agent that ran it, the folder
 * it ran in and the CLI session it ended with. The next call for the same workItemId to the same
 * node and agent picks that session back up (Claude --resume, agy --conversation). A provider
 * that can't resume, or a resume that fails, gets a short transcript of the previous attempt
 * instead. Anything else (a new work item, a failover to another node or agent) starts fresh.
 *
 * A team member may have several agents (agentIds: primary first, then backups). The server, not
 * the coordinator, picks which one runs: it skips agents whose CLI is missing or whose provider
 * ran out of quota earlier in the run, fails over to the next one inside the same call when an
 * agent hits quota, and keeps a work item on the agent that last finished it.
 *
 * A resumed team run doesn't redo finished work: each finished delegation keeps its answer, a
 * resumed coordinator asking for the same thing again gets that answer back without a process
 * (replayDelegation), and the coordinator itself resumes its own session or starts with a summary
 * of what is done (coordinatorResumePlan, used by executor.js).
 *
 * Everything with side effects is passed in (run map, agent lookup, process runner, task log),
 * so the flow can be tested with a fake runner and without the stores or any real CLI.
 */
import { createHash } from "node:crypto";
import { FAILOVER_REASONS, finishDelegation, questionFingerprint, reserveDelegation } from "./delegation-policy.js";
import { addUsage, runTokens } from "./run-usage.js";
import { openItemWorktree, integrateWorktree } from "../workspace/workspace.js";

/** Providers whose CLI can continue an earlier session: claude --resume, agy --conversation. */
const RESUMABLE_PROVIDERS = new Set(["claude", "gemini"]);
/** Per part (question, answer) of the previous attempt in a transcript fallback. */
const TRANSCRIPT_PART_MAX = 6000;

/** Rebuilds the workflow object a run executes against, from the run's own snapshot. */
export function snapshotWorkflow(run) {
  return {
    id: run.workflowId,
    nodes: run.workflowNodes || [],
    edges: run.workflowEdges || [],
    isolation: run.workflowIsolation || { enabled: false, testCommand: "", keepOnFailure: true },
    limits: run.workflowLimits || {},
  };
}

/**
 * The earlier attempt a new call continues from: the latest finished attempt of the same work
 * item by the same caller, if it went to the same node and ran on the same agent. A failover in
 * between (another node or agent took the item) means the new call starts fresh.
 */
export function previousAttempt(run, record) {
  const earlier = (run.delegations || []).filter(
    (d) => d !== record && d.callerNodeId === record.callerNodeId && d.workItemId === record.workItemId && d.status !== "running"
  );
  const last = earlier.at(-1);
  if (!last || last.targetNodeId !== record.targetNodeId || !last.agentId || last.agentId !== record.agentId) return null;
  return last;
}

const clip = (text, max) => {
  const s = String(text || "").trim();
  return s.length > max ? `${s.slice(0, max)}\n…(đã cắt bớt)` : s;
};

/**
 * How a call continues from `previous`: "resume" its CLI session, send a "transcript" of it, or
 * start "fresh". Resuming needs a resumable provider, a recorded session and (for Claude, whose
 * sessions live per folder) the same working folder as before.
 */
export function continuationPlan(previous, previousTask, { provider, cwd }) {
  if (!previous) return { mode: "fresh", transcript: null };
  const question = previousTask?.question || "";
  const answer = previousTask?.resultText || "";
  const transcript = question || answer ? { question, answer } : null;
  if (previous.sessionId && RESUMABLE_PROVIDERS.has(provider) && (previous.cwd || "") === (cwd || "")) {
    return { mode: "resume", sessionId: previous.sessionId, transcript };
  }
  return transcript ? { mode: "transcript", transcript } : { mode: "fresh", transcript: null };
}

/** What a member receives on a fresh start: its role in the team, then the request. */
function memberPrompt(node, question) {
  return node.role ? `Vai trò của bạn trong team (${node.alias}): ${node.role}\n\n---\n\n${question}` : question;
}

/** A fresh start that still remembers the previous attempt of the same work item. */
function transcriptPrompt(node, workItemId, transcript, question) {
  const parts = [`Bạn đã làm công việc "${workItemId}" này ở lần giao trước. Tóm tắt lần trước:`];
  if (transcript.question) parts.push(`### Yêu cầu lần trước\n${clip(transcript.question, TRANSCRIPT_PART_MAX)}`);
  parts.push(`### Câu trả lời của bạn lần trước\n${clip(transcript.answer, TRANSCRIPT_PART_MAX) || "(không có câu trả lời)"}`);
  parts.push(`### Yêu cầu mới cho cùng công việc\n${question}`);
  return memberPrompt(node, parts.join("\n\n"));
}

/** --------------------------- picking a member's agent --------------------------- */

/**
 * Providers this run has stopped trying: { [provider]: { reason, until, since } }, where `until`
 * is when its quota comes back (ms since the epoch) or null for the rest of the run. Kept on the
 * run so runs.json shows why a member's backup did the work.
 */
function cooldowns(run) {
  if (!run.providerCooldowns || typeof run.providerCooldowns !== "object") run.providerCooldowns = {};
  return run.providerCooldowns;
}

/** The provider's cooldown if it is still running at `now`; expired ones are dropped. */
export function activeCooldown(run, provider, now) {
  const entry = cooldowns(run)[provider];
  if (!entry) return null;
  if (entry.until && entry.until <= now) {
    delete cooldowns(run)[provider];
    return null;
  }
  return entry;
}

function markCooldown(run, provider, reason, until, now) {
  cooldowns(run)[provider] = { reason, until: until && until > now ? until : null, since: now };
}

/**
 * Cooldowns without a known end only last for one go at a run. A resume or chat turn is a new go,
 * often hours later, so those are dropped; ones with a reset time still in the future are kept.
 */
export function clearOpenEndedCooldowns(run) {
  const map = cooldowns(run);
  for (const [provider, entry] of Object.entries(map)) if (!entry.until) delete map[provider];
}

/**
 * A member's agent ids in the order to try them. Once an attempt of this work item has finished
 * successfully on one of them, that agent goes first, so later rounds stay on it as long as it
 * can run; the rest of the list stays behind it as backups.
 */
export function orderMemberAgents(run, record, agentIds) {
  const ids = [...new Set(agentIds.filter(Boolean))];
  const lastDone = (run.delegations || [])
    .filter(
      (d) =>
        d !== record &&
        d.callerNodeId === record.callerNodeId &&
        d.workItemId === record.workItemId &&
        d.targetNodeId === record.targetNodeId &&
        d.status === "done"
    )
    .at(-1);
  const sticky = lastDone?.agentId && ids.includes(lastDone.agentId) ? lastDone.agentId : null;
  return { ids: sticky ? [sticky, ...ids.filter((id) => id !== sticky)] : ids, sticky };
}

const formatTime = (ms) => new Date(ms).toLocaleString();

const cleanReviewOf = (v) => String(v || "").trim().slice(0, 80) || null;

/** --------------------------- limits for a whole team run --------------------------- */

/** What a run has used against its team limits: hand-offs that ran (replays are free) and tokens. */
export function teamLimitUsage(run) {
  return {
    delegations: (run.delegations || []).filter((d) => !d.replayedFrom).length,
    tokens: runTokens(run),
  };
}

/**
 * Throws when a run can't start another call: out of hand-offs (`delegation`), or over its token
 * budget. The message is the tool error the coordinator gets, so it says what to do next. Tokens
 * are only known once a process exits, so calls already running can still push the total past
 * the budget; this is a check before each new call, like spawn_agent's.
 * `limits` comes from the run's snapshot; runs started before team limits existed have none.
 */
export function checkTeamLimits(run, limits, { delegation = true } = {}) {
  if (!limits) return;
  const { delegations, tokens } = teamLimitUsage(run);
  if (limits.runTokenBudget && tokens >= limits.runTokenBudget) {
    throw new Error(
      `Run đã dùng ${tokens.toLocaleString()}/${limits.runTokenBudget.toLocaleString()} token (giới hạn của Team). Không giao thêm việc được: hãy viết báo cáo cuối cùng với những gì đã xong và những gì còn dang dở.`
    );
  }
  if (delegation && delegations >= limits.maxDelegations) {
    throw new Error(
      `Đã giao việc ${delegations}/${limits.maxDelegations} lần trong run này (giới hạn của Team). Không giao thêm được: hãy viết báo cáo cuối cùng với những gì đã xong và những gì còn dang dở.`
    );
  }
}

/** A team run's usage against its limits, for the Run tab; null for anything else. */
export function teamLimitSummary(run) {
  if (run.workflowType !== "team") return null;
  const limits = (run.workflowNodes || []).find((n) => n.teamRole === "coordinator")?.teamLimits;
  if (!limits) return null;
  return { ...teamLimitUsage(run), ...limits };
}

/** --------------------------- work-item worktrees: pure parts --------------------------- */

/** A member that may change files: it gets its work item's own worktree. */
export const isWriter = (agent) => agent?.accessLevel === "write" || agent?.accessLevel === "full";

/** A work item id as a folder and branch name: readable, plus a hash so two ids never collide. */
export function itemKey(itemId) {
  const readable = String(itemId).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "item";
  return `${readable}-${createHash("sha1").update(String(itemId)).digest("hex").slice(0, 6)}`;
}

/** Appended to a reviewer's request when it reviews a work item in that item's worktree. */
const REVIEW_INSTRUCTION =
  "\n\n---\nBạn đang review trong thư mục của chính công việc này. Dòng CUỐI CÙNG của câu trả lời phải là đúng một trong hai: " +
  "`REVIEW: PASS` (đạt, có thể gộp) hoặc `REVIEW: FAIL` (cần sửa).";

/** "passed" / "failed" from a review's last `REVIEW: PASS|FAIL` line; null when there is none. */
export function parseReviewVerdict(text) {
  const matches = [...String(text || "").matchAll(/^[ \t>*_`]*REVIEW[ \t]*:[ \t]*(PASS|FAIL)\b/gim)];
  if (!matches.length) return null;
  return matches.at(-1)[1].toUpperCase() === "PASS" ? "passed" : "failed";
}

/** What the coordinator is told after complete_work_item. */
function integrationMessage(itemId, result) {
  switch (result.reason) {
    case "merged":
      return `Đã kiểm thử và gộp [${itemId}] vào nhánh của điều phối viên.`;
    case "no_changes":
      return `[${itemId}] không có thay đổi file nào để gộp.`;
    case "tests_failed":
      return `Kiểm thử của [${itemId}] thất bại: KHÔNG gộp. Giao lại cho thành viên sửa (cùng workItemId) rồi gọi complete_work_item lần nữa.`;
    case "conflict":
      return `[${itemId}] xung đột với thay đổi đã gộp trước đó: đã huỷ merge, nhánh chính không đổi. Giao lại cho thành viên xử lý hoặc báo người dùng.`;
    default:
      return `Không gộp được [${itemId}] (${result.reason || "lỗi git"}).`;
  }
}

/** --------------------------- resuming a team run --------------------------- */

const SUMMARY_ANSWER_MAX = 1500;
const SUMMARY_MAX = 12000;

/**
 * Starts a new go at a run: a resume or a chat turn. Delegations remember which go they belong
 * to (run.attempt), which is how a resumed coordinator's repeat of finished work is recognised.
 */
export function beginAttempt(run) {
  run.attempt = (run.attempt || 0) + 1;
  clearOpenEndedCooldowns(run);
}

/** A finished delegation's answer: stored on it, or (runs saved before that) on its task. */
function storedAnswer(run, d) {
  if (typeof d.answer === "string") return d.answer;
  const task = run.tasks.find((t) => t.id === d.id);
  return typeof task?.resultText === "string" ? task.resultText : null;
}

/**
 * The finished delegation a resumed coordinator's call repeats: from an earlier go at the run,
 * same caller, member, work item and question (by questionFingerprint). Chat turns never replay:
 * there the user is asking for something new. Unfinished or failed delegations never match.
 */
export function replayableDelegation(run, record) {
  if (!run.attempt || run.activeTurnId) return null;
  return (
    (run.delegations || [])
      .filter(
        (d) =>
          d !== record &&
          (d.attempt || 0) < run.attempt &&
          d.status === "done" &&
          d.callerNodeId === record.callerNodeId &&
          d.targetNodeId === record.targetNodeId &&
          d.workItemId === record.workItemId &&
          d.questionFingerprint === record.questionFingerprint &&
          storedAnswer(run, d) !== null
      )
      .at(-1) || null
  );
}

/** What the coordinator's members already finished, for a coordinator starting over. */
function finishedWorkSummary(run, done) {
  const lines = done.map((d) => {
    const answer = clip(storedAnswer(run, d), SUMMARY_ANSWER_MAX) || "(không có câu trả lời)";
    return `### [${d.workItemId}] giao cho ${d.targetNodeId}${d.agentId ? ` (agent ${d.agentId})` : ""}\n${answer}`;
  });
  let text = lines.join("\n\n");
  if (text.length > SUMMARY_MAX) text = `${text.slice(0, SUMMARY_MAX)}\n…(đã cắt bớt)`;
  return [
    "## Lần chạy trước của bạn bị gián đoạn",
    "Các công việc dưới đây đã được thành viên làm xong; file họ sửa vẫn còn trong thư mục làm việc. Đừng giao lại từ đầu, chỉ giao tiếp khi cần sửa.",
    "Nếu gọi lại ask_agent với đúng workItemId và đúng nội dung như trước, hệ thống trả lại ngay kết quả đã lưu.",
    "",
    text,
  ].join("\n");
}

/** Sent into a resumed coordinator session in place of the original request. */
function resumeMessage(done) {
  const ids = [...new Set(done.map((d) => d.workItemId))];
  return [
    "Lần chạy trước bị gián đoạn (server dừng hoặc người dùng bấm Dừng). Hãy tiếp tục công việc từ chỗ đã dừng.",
    ids.length ? `Các công việc đã xong: ${ids.join(", ")}. File các thành viên đã sửa vẫn còn trong thư mục làm việc.` : "Chưa có công việc nào của thành viên được ghi nhận là đã xong.",
    "Gọi lại ask_agent với đúng workItemId và đúng nội dung như trước sẽ trả lại ngay kết quả đã lưu; việc chưa xong hoặc bị lỗi sẽ chạy bình thường.",
  ].join("\n");
}

/**
 * How a Team coordinator restarts when its run is resumed (null = not a resume, run as usual):
 *  - "resume": its own CLI session from the interrupted attempt is picked back up, with a short
 *    note in place of the request. Needs the same agent, a resumable provider and the same folder.
 *  - "summary": it starts fresh, with what its members already finished placed before its prompt.
 * `preamble` is that summary in both cases: the fallback when a resume fails.
 */
export function coordinatorResumePlan(run, node, { agent, cwd }) {
  if (!run.attempt || node.teamRole !== "coordinator") return null;
  const done = (run.delegations || []).filter((d) => d.callerNodeId === node.id && d.status === "done");
  const preamble = done.length ? finishedWorkSummary(run, done) : "";
  const provider = agent?.provider || "claude";
  const previous = run.tasks.filter((t) => t.nodeId === node.id && t.kind === "workflow-node" && t.sessionId).at(-1);
  if (previous && previous.agentId === agent?.id && RESUMABLE_PROVIDERS.has(provider) && (previous.cwd || "") === (cwd || "")) {
    return { mode: "resume", sessionId: previous.sessionId, message: resumeMessage(done), preamble };
  }
  return preamble ? { mode: "summary", preamble } : null;
}

/**
 * deps: { runs, getAgent, agentForNode, nodeTitle, runAgentProcess, newTask, emit, pushTaskLog,
 *         isCancelling, providerAvailable, maxCallDepth, killTask, now?, minuteMs? }
 * (same signatures as the real ones in executor.js / run-store.js / agents.store.js /
 * node-title.js / cli-runners.js; providerAvailable(provider) reads PROVIDER_AVAILABILITY).
 */
export function createTeamCalls(deps) {
  const { runs, getAgent, agentForNode, nodeTitle, runAgentProcess, newTask, emit, pushTaskLog, isCancelling, providerAvailable, maxCallDepth } = deps;
  const now = deps.now || (() => Date.now());
  // Kills one task's processes (killTaskProcesses); minuteMs is only shortened by tests.
  const killTask = deps.killTask || (() => {});
  const minuteMs = deps.minuteMs || 60_000;

  /**
   * Runs one agent for one call, continuing the previous attempt when there is one.
   * Returns the process result plus the session id to record for the next round.
   */
  async function runMember({ runId, task, record, run, targetNode, targetAgent, question, workflow, cwd, depth, call = {} }) {
    const log = (line) => pushTaskLog(runId, task.id, line);
    const provider = targetAgent?.provider || "claude";
    const previous = previousAttempt(run, record);
    const previousTask = previous && run.tasks.find((t) => t.id === previous.id);
    const plan = continuationPlan(previous, previousTask, { provider, cwd });
    // The session id is recorded as soon as the CLI reports it, so a crash mid-call still leaves
    // something to resume.
    const onSessionId = (id) => {
      record.sessionId = id;
      task.sessionId = id;
    };
    const base = { runId, taskId: task.id, cwd, agent: targetAgent, node: targetNode, workflow, depth: depth + 1, onSessionId };
    const fallbackPrompt = plan.transcript ? transcriptPrompt(targetNode, record.workItemId, plan.transcript, question) : memberPrompt(targetNode, question);

    if (plan.mode === "resume") {
      log(`↩️ Tiếp tục phiên CLI của lần giao trước cho [${record.workItemId}].`);
      task.continuation = "resumed";
      const result = await runAgentProcess({ ...base, prompt: question, resume: plan.sessionId });
      // Out of quota or no CLI says nothing about the session: retrying the same agent with a
      // transcript would fail the same way, so that goes back to the caller to fail over. A call
      // that ran out of time is over.
      if (result.ok || result.resultText || isCancelling(runId) || call.timedOut || FAILOVER_REASONS.has(result.failureReason)) {
        return { ...result, sessionId: result.sessionId || plan.sessionId };
      }
      log(
        plan.transcript
          ? "⚠️ Không mở lại được phiên cũ, gửi lại kèm tóm tắt lần trước."
          : "⚠️ Không mở lại được phiên cũ, chạy lại từ đầu."
      );
      task.continuation = plan.transcript ? "transcript" : "fresh";
      const retry = await runAgentProcess({ ...base, prompt: fallbackPrompt, resume: null });
      return { ...retry, usage: addUsage(result.usage, retry.usage) };
    }

    if (plan.mode === "transcript") log(`↩️ Gửi kèm tóm tắt lần giao trước cho [${record.workItemId}] (provider không mở lại được phiên CLI).`);
    else log(previous ? `🆕 Phiên mới cho [${record.workItemId}] (lần trước không có gì để nối tiếp).` : `🆕 Phiên mới cho [${record.workItemId}].`);
    task.continuation = plan.mode;
    return runAgentProcess({ ...base, prompt: fallbackPrompt, resume: null });
  }

  /**
   * The agents a call may run on, in order. A team member tries its agent list (see
   * orderMemberAgents); any other node runs its one agent exactly as before.
   */
  function candidatesFor(run, record, node) {
    if (node.teamRole !== "member") return { agents: [agentForNode(node)], sticky: null, failover: false };
    const { ids, sticky } = orderMemberAgents(run, record, node.agentIds?.length ? node.agentIds : [node.agentId]);
    const agents = ids.map((id) => {
      const agent = getAgent(id);
      return agent?.id === id ? agent : { id, name: id, missing: true };
    });
    return { agents, sticky, failover: true };
  }

  /** --------------------------- one worktree per work item --------------------------- */

  /**
   * runId -> the team's workspace while its coordinator runs with isolation on in a git repo:
   * { session, base: { dir, branch, label }, keptDirs, open: Map(workItemId -> worktree), queue }.
   * `base` is the coordinator's worktree: work items fork from it and merge back into it, so the
   * coordinator (and its end-of-run merge into the review) sees integrated work.
   */
  const teamWorkspaces = new Map();

  function openTeamWorkspace(runId, { session, base, keptDirs = [] }) {
    teamWorkspaces.set(runId, {
      session,
      base: { dir: base.dir, branch: base.branch, label: `nhánh của điều phối viên (${base.branch})` },
      keptDirs,
      open: new Map(),
      queue: Promise.resolve(),
    });
  }

  function closeTeamWorkspace(runId) {
    teamWorkspaces.delete(runId);
  }

  /** git takes repo-wide locks for worktree add and merge: one operation per run at a time. */
  function serial(ws, fn) {
    const next = ws.queue.then(fn, fn);
    ws.queue = next.catch(() => {});
    return next;
  }

  const workItems = (run) => (run.workItems && typeof run.workItems === "object" ? run.workItems : (run.workItems = {}));

  /** The worktree a work item is written in: opened on its first call, reused for fix rounds. */
  async function itemWorktree(run, ws, itemId, log) {
    if (ws.open.has(itemId)) return ws.open.get(itemId);
    const wt = await serial(ws, () => openItemWorktree(ws.session, itemKey(itemId), ws.base.branch, log));
    if (!wt) return null;
    ws.open.set(itemId, wt);
    const entry = workItems(run)[itemId] || {};
    workItems(run)[itemId] = { ...entry, key: itemKey(itemId), branch: wt.branch, dir: wt.dir, status: "open" };
    return wt;
  }

  /**
   * Where one agent works on a call. Without the team workspace: the caller's folder, as before.
   * With it: a member that may write gets its work item's own worktree; a read-only member works
   * in the worktree of the item named in `reviewOf`, else in the base (the coordinator's folder).
   * Returns null when a writer's worktree can't be made: it then doesn't run at all, rather than
   * writing into a folder others share.
   */
  async function placeFor({ runId, run, targetNode, agent, record, reviewOf, cwd, log }) {
    const ws = targetNode.teamRole === "member" ? teamWorkspaces.get(runId) : null;
    if (!ws) return { cwd };
    if (isWriter(agent)) {
      const wt = await itemWorktree(run, ws, record.workItemId, log);
      if (!wt) {
        log("❌ Không tạo được worktree riêng cho công việc này; không chạy để bảo vệ thư mục dùng chung.");
        return null;
      }
      return { cwd: wt.dir, itemId: record.workItemId };
    }
    const reviewed = reviewOf ? workItems(run)[reviewOf] : null;
    if (reviewOf && reviewed?.status === "open") {
      const wt = await itemWorktree(run, ws, reviewOf, log);
      if (wt) {
        log(`🔎 Review trong worktree của [${reviewOf}]: ${wt.dir}`);
        return { cwd: wt.dir, reviewing: reviewOf };
      }
    }
    if (reviewOf) log(`ℹ️ [${reviewOf}] không có worktree đang mở; chạy trong thư mục chung.`);
    return { cwd: ws.base.dir };
  }

  /** After a successful call: new writes need a new review; a review records its verdict. */
  function noteWorkItem(run, place, answer, log) {
    if (place.itemId) {
      workItems(run)[place.itemId].lastReview = null;
    } else if (place.reviewing) {
      const verdict = parseReviewVerdict(answer);
      workItems(run)[place.reviewing].lastReview = verdict;
      log(verdict === "passed" ? `✅ Review [${place.reviewing}]: ĐẠT.` : verdict === "failed" ? `❌ Review [${place.reviewing}]: CHƯA ĐẠT.` : `⚠️ Review [${place.reviewing}] không có dòng REVIEW: PASS/FAIL, coi như chưa đạt.`);
    }
  }

  /** Tests and merges one work item into the base, exactly like a Pipeline branch is merged. */
  async function integrateItem(run, ws, itemId, log) {
    const entry = workItems(run)[itemId];
    const wt = ws.open.get(itemId) || (await openItemWorktree(ws.session, entry.key || itemKey(itemId), ws.base.branch, log));
    if (!wt) return { ok: false, reason: "worktree_missing" };
    const result = await integrateWorktree(ws.session, wt, { title: `[${itemId}] (${run.id})`, agentFailed: false, log, into: ws.base });
    ws.open.delete(itemId);
    entry.status = result.ok ? "integrated" : "failed";
    entry.integration = result.reason;
    if (!result.ok && ws.session.keepOnFailure) ws.keptDirs.push(wt.dir);
    return result;
  }

  /**
   * The `complete_work_item` bridge tool: the coordinator says a work item is finished. Its
   * worktree is tested (isolation.testCommand) and merged into the coordinator's branch.
   */
  async function completeWorkItem({ runId, workItemId, callerTaskId }) {
    const run = runs.get(runId);
    if (!run) throw new Error("Run không tồn tại (có thể đã kết thúc).");
    const ws = teamWorkspaces.get(runId);
    if (!ws) throw new Error("Run này không có worktree riêng cho từng công việc (isolation tắt hoặc thư mục không phải git repo); không có gì để gộp.");
    const itemId = String(workItemId || "").trim().slice(0, 80);
    const entry = workItems(run)[itemId];
    if (!entry) throw new Error(`Công việc "${itemId}" chưa có worktree riêng (chưa thành viên nào được ghi file làm việc này).`);
    if (entry.status === "integrated") throw new Error(`Công việc "${itemId}" đã được gộp rồi.`);
    if ((run.delegations || []).some((d) => d.workItemId === itemId && d.status === "running")) {
      throw new Error(`Công việc "${itemId}" vẫn đang có thành viên làm; đợi xong rồi mới gộp.`);
    }
    const log = (line) => pushTaskLog(runId, callerTaskId, line);
    log(`📥 Gộp công việc [${itemId}] vào nhánh của điều phối viên.`);
    const result = await serial(ws, () => integrateItem(run, ws, itemId, log));
    emit({ runId, type: "run-updated" });
    return { ok: result.ok, reason: result.reason, message: integrationMessage(itemId, result) };
  }

  /**
   * End of a coordinator's run: work items whose last review passed and that weren't merged yet
   * are merged now; the rest stay on their own branches (logged), as a failed Pipeline branch does.
   */
  async function finishWorkItems(runId, log) {
    const run = runs.get(runId);
    const ws = teamWorkspaces.get(runId);
    if (!run || !ws) return;
    for (const [itemId, entry] of Object.entries(workItems(run))) {
      if (entry.status !== "open") continue;
      if (entry.lastReview === "passed") {
        log(`📥 [${itemId}] đã review đạt: gộp vào nhánh của điều phối viên.`);
        await serial(ws, () => integrateItem(run, ws, itemId, log));
      } else {
        log(`⏸️ [${itemId}] chưa được gộp (chưa review đạt, chưa gọi complete_work_item). Nhánh ${entry.branch} được giữ lại: ${entry.dir}`);
        ws.keptDirs.push(entry.dir);
      }
    }
  }

  /** Why a member's agent can't take a call right now, or null when it can. */
  function skipReason(run, agent, provider) {
    if (agent.missing) return { reason: "provider_unavailable", message: `⏭️ Bỏ qua agent "${agent.id}": không còn tồn tại.` };
    if (!providerAvailable(provider)) {
      return { reason: "provider_unavailable", message: `⏭️ Bỏ qua ${agent.name}: CLI ${provider} chưa được cài trên server.` };
    }
    const cd = activeCooldown(run, provider, now());
    if (!cd) return null;
    const what = cd.reason === "quota" ? "hết quota" : "không khả dụng";
    return { reason: cd.reason, message: `⏭️ Bỏ qua ${agent.name}: ${provider} ${what} trong run này${cd.until ? ` (tới ${formatTime(cd.until)})` : ""}.` };
  }

  /**
   * Runs the call on the first agent that can take it. For a team member: agents whose CLI is not
   * installed, or whose provider ran out of quota earlier in this run, are skipped; an agent that
   * fails on quota or an unavailable CLI puts its provider on cooldown and the next agent takes
   * over inside the same call, under the same work item. The coordinator sees one member.
   */
  async function runWithFailover({ runId, task, record, run, targetNode, question, workflow, cwd, depth, reviewOf, timeoutMinutes }) {
    const log = (line) => pushTaskLog(runId, task.id, line);
    const { agents, sticky, failover } = candidatesFor(run, record, targetNode);
    if (sticky && agents.length > 1) log(`📌 [${record.workItemId}] đã chạy xong trên ${agents[0].name}, giữ agent này nếu còn chạy được.`);

    // One deadline for the whole call, failover included: when it passes, whatever process the
    // call is running is killed (tree and all) and the call ends as "timeout".
    const call = { timedOut: false };
    const timer = timeoutMinutes
      ? setTimeout(() => {
          call.timedOut = true;
          log(`⏱️ Lần giao việc vượt giới hạn ${timeoutMinutes} phút: đang dừng agent.`);
          killTask(task.id);
        }, timeoutMinutes * minuteMs)
      : null;
    try {
      const outcome = await tryAgents({ runId, task, record, run, targetNode, question, workflow, cwd, depth, reviewOf, call, agents, failover, log });
      return call.timedOut ? { ...outcome, ok: false, failureReason: "timeout" } : outcome;
    } finally {
      clearTimeout(timer);
    }
  }

  /** runWithFailover's loop: each agent of the member in turn until one does the work. */
  async function tryAgents({ runId, task, record, run, targetNode, question, workflow, cwd, depth, reviewOf, call, agents, failover, log }) {
    const skipped = [];
    let result = null;
    let place = null;
    let used = null;
    let usage = null;
    for (const [i, agent] of agents.entries()) {
      if (isCancelling(runId) || call.timedOut) break;
      const provider = agent.provider || "claude";
      if (failover) {
        const skip = skipReason(run, agent, provider);
        if (skip) {
          log(skip.message);
          skipped.push(skip.reason);
          continue;
        }
      }

      record.agentId = agent.id || null;
      record.provider = provider;
      task.agentId = agent.id || null;
      task.agentName = agent.name || null;
      task.provider = provider;
      // Where this agent works: its work item's own worktree, the one it reviews, or the base.
      place = await placeFor({ runId, run, targetNode, agent, record, reviewOf, cwd, log });
      used = agent;
      if (!place) {
        result = { ok: false, resultText: "", usage: null, failureReason: "agent_error" };
        break;
      }
      record.cwd = place.cwd;
      const prompt = place.reviewing ? `${question}${REVIEW_INSTRUCTION}` : question;
      result = await runMember({ runId, task, record, run, targetNode, targetAgent: agent, question: prompt, workflow, cwd: place.cwd, depth, call });
      usage = addUsage(usage, result.usage);
      if (!failover || result.ok || isCancelling(runId) || call.timedOut || !FAILOVER_REASONS.has(result.failureReason)) break;

      markCooldown(run, provider, result.failureReason, result.quotaResetAt, now());
      const cd = cooldowns(run)[provider];
      const until = cd.until ? ` tới ${formatTime(cd.until)}` : " tới hết run";
      log(`🔀 ${agent.name} lỗi (${result.failureReason}), tạm ngưng ${provider}${until}.${i + 1 < agents.length ? " Thử agent tiếp theo của thành viên." : ""}`);
    }

    if (!result) {
      const failureReason = skipped.includes("quota") ? "quota" : "provider_unavailable";
      if (!isCancelling(runId)) log(`❌ Thành viên ${targetNode.alias || targetNode.id} không còn agent nào chạy được (${failureReason}).`);
      return { ok: false, resultText: "", usage: null, failureReason: isCancelling(runId) ? "cancelled" : failureReason, agent: null };
    }
    if (call.timedOut) return { ...result, usage, agent: used, place };
    if (failover && result.ok) log(`✅ Thực hiện bởi ${used.name} (${used.provider || "claude"}).`);
    if (result.ok && place) noteWorkItem(run, place, result.resultText, log);
    return { ...result, usage, agent: used, place };
  }

  /**
   * Called (via the HTTP endpoint the mcp-bridge process hits) while `callerNodeId` is mid-run
   * inside `runId`. Permission is scoped to the run's own snapshot of the workflow: the caller
   * must list `targetNodeId` in its `calleeNodeIds`. Runs the target synchronously as its own
   * task in the same run and returns its answer to the caller's `ask_agent` tool call.
   *
   * The delegation rules (delegation-policy.js) apply to the caller's choice of node. Which of a
   * member's agents runs the work is the server's own decision and doesn't go through them.
   */
  async function askAgent({ runId, workflowId, callerNodeId, callerTaskId = null, targetNodeId, question, workItemId, parentWorkItemId, reviewOf, cwd, depth }) {
    const run = runs.get(runId);
    if (!run) throw new Error("Run không tồn tại (có thể đã kết thúc).");
    if (depth >= maxCallDepth) throw new Error("Đã đạt giới hạn độ sâu gọi agent (chống vòng lặp gọi nhau).");

    // The graph the run started with, not the live workflow: editing a workflow mid-run must not
    // change who may hand work to whom inside that run.
    if (!run.workflowId || run.workflowId !== workflowId) throw new Error("Run này không thuộc workflow đó.");
    const workflow = snapshotWorkflow(run);
    const callerNode = workflow.nodes.find((n) => n.id === callerNodeId);
    if (!callerNode?.calleeNodeIds?.includes(targetNodeId)) {
      throw new Error("Bước này chưa được phép giao việc cho bước đó (mục \"Được giao việc cho\" trong Workflow editor).");
    }
    if (targetNodeId === callerNodeId) throw new Error("Một bước không được tự gọi chính nó.");

    const targetNode = workflow.nodes.find((n) => n.id === targetNodeId);
    if (!targetNode) throw new Error("Bước đích không còn tồn tại trong workflow.");

    // Team limits, checked before anything is reserved. A call a resumed coordinator repeats is
    // answered from the run without a process, so it is neither counted nor refused.
    const limits = callerNode.teamLimits || null;
    const probe = { callerNodeId, targetNodeId, workItemId: String(workItemId || "").trim().slice(0, 80), questionFingerprint: questionFingerprint(question) };
    if (limits && !replayableDelegation(run, probe)) {
      try {
        checkTeamLimits(run, limits);
      } catch (err) {
        if (callerTaskId) pushTaskLog(runId, callerTaskId, `⛔ ${err.message}`);
        throw err;
      }
    }

    const task = newTask(`💬 ${nodeTitle(callerNode)} giao [${workItemId}] cho ${nodeTitle(targetNode)}`, "agent-call", targetNode.id, agentForNode(targetNode));
    if (run.activeTurnId) task.turnId = run.activeTurnId; // part of a chat turn: deleted with it
    const delegation = reserveDelegation(run, {
      callerNodeId,
      targetNodeId,
      workItemId,
      parentWorkItemId,
      question,
      assignmentId: task.id,
    });
    // Who ran it and where: what the next round of this work item needs to continue it.
    // agentId/provider end up as the agent that actually did the work.
    delegation.agentId = null;
    delegation.provider = null;
    delegation.cwd = cwd || "";
    delegation.sessionId = null;
    delegation.attempt = run.attempt || 0;
    task.workItemId = delegation.workItemId;
    task.parentWorkItemId = delegation.parentWorkItemId;
    task.question = question;
    run.tasks.push(task);
    emit({ runId, taskId: task.id, type: "task-created", task });
    task.status = "running";
    emit({ runId, taskId: task.id, type: "task-status", status: "running" });
    pushTaskLog(runId, task.id, `❓ ${question}`);

    const replay = replayableDelegation(run, delegation);
    if (replay) return replayDelegation({ runId, run, task, delegation, replay, targetNode });

    let processResult;
    try {
      processResult = await runWithFailover({ runId, task, record: delegation, run, targetNode, question, workflow, cwd, depth, reviewOf: cleanReviewOf(reviewOf), timeoutMinutes: limits?.callTimeoutMinutes || 0 });
    } catch (err) {
      pushTaskLog(runId, task.id, `❌ Lỗi nội bộ khi chạy agent: ${err.message}`);
      processResult = { ok: false, resultText: "", usage: null, failureReason: "agent_error", agent: null };
    }
    const { ok, resultText, usage, failureReason, sessionId, agent, place } = processResult;

    task.resultText = resultText;
    task.usage = usage;
    task.sessionId = sessionId || null;
    task.failureReason = failureReason || null;
    task.status = isCancelling(runId) ? "cancelled" : ok ? "done" : "error";
    delegation.sessionId = sessionId || null;
    // Kept on the run so a resumed coordinator asking the same thing again gets it back as is.
    if (task.status === "done") delegation.answer = resultText;
    finishDelegation(delegation, {
      ok: task.status === "done",
      failureReason: task.status === "cancelled" ? "cancelled" : failureReason,
    });
    emit({ runId, taskId: task.id, type: "task-status", status: task.status, usage });

    const reply = memberReply(targetNode, { answer: resultText, ok: task.status === "done", failureReason: task.failureReason }, agent);
    if (place?.itemId && reply.ok) reply.note = `Làm trong worktree riêng của [${place.itemId}]; gọi complete_work_item khi công việc đã xong và review đạt.`;
    if (place?.reviewing && reply.ok) reply.review = workItems(run)[place.reviewing]?.lastReview || null;
    return reply;
  }

  /** A team member is one name to the coordinator; `agent` says which of its agents did the work. */
  function memberReply(targetNode, reply, agent) {
    if (targetNode.teamRole === "member" && agent) reply.agent = { id: agent.id, name: agent.name, provider: agent.provider || "claude" };
    return reply;
  }

  /**
   * Answers a resumed coordinator from a delegation an earlier attempt of the run already
   * finished, without spawning anything. The new record carries the old one's agent, folder and
   * session, so a later fix round of the same work item still continues that session.
   */
  function replayDelegation({ runId, run, task, delegation, replay, targetNode }) {
    const answer = storedAnswer(run, replay);
    const known = replay.agentId ? getAgent(replay.agentId) : null;
    const agent = known?.id === replay.agentId ? known : replay.agentId ? { id: replay.agentId, name: replay.agentId, provider: replay.provider } : null;
    Object.assign(delegation, {
      agentId: replay.agentId || null,
      provider: replay.provider || null,
      cwd: replay.cwd || delegation.cwd,
      sessionId: replay.sessionId || null,
      answer,
      replayedFrom: replay.id,
    });
    finishDelegation(delegation, { ok: true });
    task.agentId = agent?.id || task.agentId;
    task.agentName = agent?.name || task.agentName;
    task.provider = agent?.provider || task.provider;
    task.sessionId = replay.sessionId || null;
    task.replayedFrom = replay.id;
    task.continuation = "replayed";
    task.resultText = answer;
    pushTaskLog(runId, task.id, `♻️ [${delegation.workItemId}] đã xong ở lần chạy trước: trả lại kết quả đã lưu, không chạy lại agent.`);
    task.status = "done";
    emit({ runId, taskId: task.id, type: "task-status", status: "done" });
    return memberReply(targetNode, { answer, ok: true, failureReason: null, replayed: true }, agent);
  }

  return { askAgent, completeWorkItem, openTeamWorkspace, closeTeamWorkspace, finishWorkItems };
}
