/**
 * Run history: the in-memory run map, its persistence to runs.json, the event bus the
 * WebSocket broadcasts from, and the read-side views (summaries, usage totals). Also owns the
 * per-run "stop requested" flag, since summaries report it.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { acceptWorkspaceReview, declineWorkspaceReview } from "../workspace/workspace.js";
import { shouldRenderLogLine } from "../../core/log-utils.js";
import { SERVER_DIR, PROVIDERS, loadJson } from "../../core/config.js";
import { teamLimitSummary } from "./team-calls.js";

const RUNS_FILE = path.join(SERVER_DIR, "runs.json");

/** --------------------------- runs --------------------------- */

/** In-memory store: runId -> run object, persisted to runs.json so history/logs survive a
 * server restart (previously in-memory only — lost on every restart). */
const runs = new Map();

/**
 * Claude's account-wide rate-limit status, opportunistically captured off the `rate_limit_event`
 * line every `claude -p --output-format stream-json` call already emits (see runClaudeProcess) —
 * no extra request, no extra cost, just read off traffic that was happening anyway. It's
 * account-level, not per-agent/per-run, hence one shared value here rather than living on a task.
 * Resets to null on server restart and is filled again by the next Claude run; there is no
 * "fetch it right now for free" call, so the UI shows this as "as of <last run>" rather than live.
 *
 * Codex has no equivalent: `codex exec --json` (checked against CLI 0.146.0) never emits a
 * rate-limit/quota event — its help output has no `codex usage`/`codex quota` subcommand either.
 * So this stays Claude-only; the client is told to say so rather than fabricate a Codex number.
 */
let lastClaudeQuota = null;

function saveRuns() {
  try {
    writeFileSync(RUNS_FILE, JSON.stringify([...runs.values()], null, 2), "utf-8");
  } catch (err) {
    console.error("[orchestrator] Không lưu được runs.json:", err.message);
  }
}

// Throttled (not debounced): during a burst of events (e.g. streaming log lines) this saves at
// most once every ~400ms rather than on every single line, while still guaranteeing a save
// lands soon after any change — including the very last event of a run, since the timeout
// re-reads `runs` fresh when it fires, not a stale snapshot taken when it was scheduled.
let saveRunsTimer = null;
function scheduleSaveRuns() {
  if (saveRunsTimer) return;
  saveRunsTimer = setTimeout(() => {
    saveRunsTimer = null;
    saveRuns();
  }, 400);
}

/** Loads persisted runs on startup. A run (or task) still `status: "running"` in the saved
 * file means the server process died mid-run — the spawned CLI child is long gone and can't be
 * resumed, so it's marked as errored rather than silently stuck "running" forever. Whatever
 * log/output had already accumulated before the crash is kept as-is. */
function loadRuns() {
  const raw = loadJson(RUNS_FILE, []);
  for (const r of raw) {
    if (r.status === "running") {
      r.status = "error";
      r.error =
        r.error ||
        "Server đã dừng trong khi run này đang chạy dở — tiến trình bị ngắt. Log/kết quả đã có tới lúc đó vẫn được giữ nguyên. " +
        "Nếu là run theo workflow, bấm \"Chạy tiếp\" để chạy lại từ bước bị gián đoạn thay vì làm lại từ đầu.";
    }
    for (const t of r.tasks || []) {
      if (t.status === "running") t.status = "error";
    }
    for (const delegation of r.delegations || []) {
      if (delegation.status === "running") {
        delegation.status = "error";
        delegation.failureReason = "interrupted";
        delegation.finishedAt = Date.now();
      }
    }
    runs.set(r.id, r);
  }
}
loadRuns();

/** Records the latest Claude rate-limit event (see lastClaudeQuota above). */
function setClaudeQuota(info) {
  lastClaudeQuota = { ...info, updatedAt: Date.now() };
}

/** Runs the user asked to stop. Separate from the child processes on purpose: killing what's
 * currently running isn't enough, the graph/subtask loops also have to stop *scheduling* the
 * work that hasn't started yet, and they check this. Cleared when a run is resumed. */
const cancelling = new Set();

const isCancelling = (runId) => cancelling.has(runId);

/** Set of listener callbacks(event) for broadcasting to WS clients */
const listeners = new Set();

function emit(event) {
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      /* ignore */
    }
  }
  scheduleSaveRuns();
}

function pushTaskLog(runId, taskId, line) {
  const normalized = String(line || "").trim();
  if (!shouldRenderLogLine(normalized)) return;

  const run = runs.get(runId);
  const task = run?.tasks.find((t) => t.id === taskId);
  if (task) task.log.push(normalized);
  emit({ runId, taskId, type: "log", line: normalized });
}

function listRuns() {
  return [...runs.values()]
    .map(summarize)
    // Most recently active first: a run that just got a chat turn or was resumed jumps to the top.
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
}

function summarize(run, { includeReviewPatch = false } = {}) {
  const review = run.review
    ? {
      ...run.review,
      patch: includeReviewPatch ? run.review.patch || "" : undefined,
      files: run.review.files?.map((f) => (includeReviewPatch ? f : { ...f, patch: undefined })),
    }
    : null;
  return {
    id: run.id,
    prompt: run.prompt,
    agentId: run.agentId,
    workflowId: run.workflowId,
    workflowType: run.workflowId ? run.workflowType || "pipeline" : null,
    targetBranch: run.targetBranch || null,
    inputs: run.inputs || null,
    trigger: run.trigger || null,
    workflowNodes: run.workflowNodes || null,
    workflowEdges: run.workflowEdges || null,
    decompose: run.decompose,
    cwd: run.cwd,
    status: run.status,
    error: run.error || null,
    createdAt: run.createdAt,
    lastActivityAt: run.lastActivityAt || run.createdAt,
    stopping: run.status === "running" && isCancelling(run.id),
    resumable: canResume(run),
    // A Team run's usage against its limits (delegations, tokens), for the Run tab.
    teamLimits: teamLimitSummary(run),
    review,
    tasks: run.tasks.map((t) => ({
      id: t.id,
      nodeId: t.nodeId || null,
      title: t.title,
      kind: t.kind,
      status: t.status,
      log: t.log,
      resultText: t.resultText,
      provider: t.provider || null,
      agentId: t.agentId || null,
      agentName: t.agentName || null,
      workItemId: t.workItemId || null,
      parentWorkItemId: t.parentWorkItemId || null,
      failureReason: t.failureReason || null,
      spawnedByTaskId: t.spawnedByTaskId || null,
      userMessage: t.userMessage || null,
      turnId: t.turnId || null,
      spawn: t.spawn || null,
      usage: t.usage || null,
    })),
  };
}

/**
 * Rolls up every task's `usage` (see normalizeClaudeUsage/normalizeCodexUsage) across all
 * persisted runs into per-provider totals, plus a per-agent breakdown so "which agent burns the
 * most tokens" is answerable without scraping run history by hand. Recomputed on each request
 * rather than kept as a running counter — usage figures live on the tasks themselves (already
 * persisted in runs.json), so this is just an aggregate view over data that already exists, and
 * staying stateless means deleting/clearing run history is automatically reflected too.
 */
function getUsageSummary() {
  const empty = () => ({
    tasks: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    hasCost: false,
    durationMs: 0,
  });
  const byProvider = Object.fromEntries(PROVIDERS.map((p) => [p, empty()]));
  const byAgent = new Map(); // agentId -> { agentId, agentName, provider, ...empty() }

  for (const run of runs.values()) {
    for (const t of run.tasks) {
      const u = t.usage;
      if (!u || !byProvider[u.provider]) continue;

      const p = byProvider[u.provider];
      p.tasks++;
      p.inputTokens += u.inputTokens || 0;
      p.outputTokens += u.outputTokens || 0;
      p.cacheReadTokens += u.cacheReadTokens || 0;
      p.cacheCreationTokens += u.cacheCreationTokens || 0;
      p.durationMs += u.durationMs || 0;
      if (typeof u.costUsd === "number") {
        p.costUsd += u.costUsd;
        p.hasCost = true;
      }

      const spawned = t.kind === "agent-spawn";
      const agentKey = spawned ? `spawned-${u.provider}` : t.agentId || `unknown-${u.provider}`;
      if (!byAgent.has(agentKey)) {
        byAgent.set(agentKey, {
          agentId: t.agentId || null,
          agentName: spawned ? `🧬 Agent tạo động (${u.provider})` : t.agentName || "(agent đã xoá)",
          provider: u.provider,
          ...empty(),
        });
      }
      const a = byAgent.get(agentKey);
      a.tasks++;
      a.inputTokens += u.inputTokens || 0;
      a.outputTokens += u.outputTokens || 0;
      a.cacheReadTokens += u.cacheReadTokens || 0;
      a.cacheCreationTokens += u.cacheCreationTokens || 0;
      a.durationMs += u.durationMs || 0;
      if (typeof u.costUsd === "number") {
        a.costUsd += u.costUsd;
        a.hasCost = true;
      }
    }
  }

  return {
    byProvider,
    byAgent: [...byAgent.values()].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)),
    quota: {
      // { status, resetsAt, rateLimitType, utilization, isUsingOverage, updatedAt } | null — see
      // lastClaudeQuota above for why this is opportunistic/account-wide rather than live-fetched.
      claude: lastClaudeQuota,
      // Not a bug we can fix client-side: codex exec --json has no rate-limit event to read.
      codexAvailable: false,
    },
  };
}

function getRun(runId) {
  const run = runs.get(runId);
  return run ? summarize(run, { includeReviewPatch: true }) : null;
}

async function acceptRunReview(runId) {
  const run = runs.get(runId);
  if (!run) return false;
  if (run.status === "running") throw new Error("Run vẫn đang chạy.");
  if (run.review?.status !== "pending") throw new Error("Run không có thay đổi đang chờ review.");
  await acceptWorkspaceReview(run.review);
  run.review = { ...run.review, status: "accepted", decidedAt: Date.now() };
  emit({ runId, type: "review-status", status: "accepted" });
  saveRuns();
  return true;
}

async function declineRunReview(runId) {
  const run = runs.get(runId);
  if (!run) return false;
  if (run.status === "running") throw new Error("Run vẫn đang chạy.");
  if (run.review?.status !== "pending") throw new Error("Run không có thay đổi đang chờ review.");
  await declineWorkspaceReview(run.review);
  run.review = { ...run.review, status: "declined", decidedAt: Date.now() };
  emit({ runId, type: "review-status", status: "declined" });
  saveRuns();
  return true;
}

/** Deletes one run from history. Refuses to delete a still-`running` run — its spawned CLI
 * process is still writing into `run.tasks[].log` by reference; deleting the Map entry out
 * from under it wouldn't stop that process, just orphan its output nowhere the UI can show it. */
function deleteRun(id) {
  const run = runs.get(id);
  if (!run) return false;
  if (run.status === "running") {
    throw new Error("Không thể xoá run đang chạy. Đợi run hoàn tất (hoặc lỗi) rồi mới xoá.");
  }
  if (run.review?.status === "pending") {
    throw new Error("Hãy Accept hoặc Decline thay đổi trước khi xoá run.");
  }
  runs.delete(id);
  saveRuns();
  emit({ runId: id, type: "run-deleted" });
  return true;
}

/** Clears all run history except runs still `running` (same reasoning as deleteRun) — those
 * are silently kept rather than erroring out a bulk "clear all" action. */
function clearRuns() {
  let cleared = 0;
  let kept = 0;
  for (const [id, run] of runs) {
    if (run.status === "running" || run.review?.status === "pending") {
      kept++;
    } else {
      runs.delete(id);
      cleared++;
    }
  }
  saveRuns();
  emit({ type: "runs-cleared" });
  return { cleared, kept };
}

// `agent` is optional and only meaningful for task kinds that actually spawn a CLI (agent,
// agent-call, workflow-node, workflow-router) — recorded up front (not just usage, after the
// fact) so a task still shows which provider/agent it ran under even if the process errors out
// before producing any usage numbers. See getUsageSummary() for how this rolls up.
function newTask(title, kind, nodeId = null, agent = null) {
  return {
    id: nanoid(8),
    nodeId,
    title,
    kind,
    status: "pending",
    log: [],
    resultText: "",
    provider: agent ? (PROVIDERS.includes(agent.provider) ? agent.provider : "claude") : null,
    agentId: agent?.id || null,
    agentName: agent?.name || null,
    usage: null,
  };
}

/** True when a stopped/crashed/failed workflow run still has nodes that never completed. */
function canResume(run) {
  if (!run || run.status === "running" || !run.workflowId) return false;
  if (["pending", "declined"].includes(run.review?.status)) return false;
  const nodes = (run.workflowNodes || []).filter((n) => n.autoStart !== false);
  if (!nodes.length) return false;
  const saved = run.checkpoint?.nodeStates || {};
  return nodes.some((n) => saved[n.id] !== "done");
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export {
  runs,
  cancelling,
  isCancelling,
  setClaudeQuota,
  saveRuns,
  scheduleSaveRuns,
  emit,
  subscribe,
  pushTaskLog,
  newTask,
  summarize,
  canResume,
  listRuns,
  getRun,
  getUsageSummary,
  acceptRunReview,
  declineRunReview,
  deleteRun,
  clearRuns,
};
