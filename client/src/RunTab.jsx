import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "./api.js";
import WorkflowCanvas from "./WorkflowCanvas.jsx";
import DirBrowserModal from "./DirBrowserModal.jsx";
import { IconPlay, IconTrash, ProviderIcon } from "./Icons.jsx";
import { usePreferences } from "./PreferencesContext.jsx";
import {
  Badge,
  Button,
  CheckboxField,
  ConfirmModal,
  ErrorBox,
  HelperText,
  SegmentedControl,
} from "./components/index.js";

function useWebSocket(onEvent) {
  const wsRef = useRef(null);
  const onEventRef = useRef(onEvent);

  useEffect(() => {
    onEventRef.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    wsRef.current = ws;
    ws.onmessage = (msg) => {
      try {
        onEventRef.current(JSON.parse(msg.data));
      } catch {
        /* ignore */
      }
    };
    return () => ws.close();
  }, []);
}

const INITIAL_LOG_LIMIT = 400;
const LOG_PAGE_SIZE = 400;

function getLogLineClass(line) {
  if (!line) return "log-default";
  if (line.startsWith("❌")) return "log-error";
  if (line.startsWith("⚠️")) return "log-warning";
  if (line.startsWith("🔧")) return "log-tool";
  if (line.startsWith("✅")) return "log-success";
  if (line.startsWith("ℹ️")) return "log-info";
  return "log-default";
}

const TaskCard = React.memo(function TaskCard({ task }) {
  const { t } = usePreferences();
  const [open, setOpen] = useState(true);
  const [visibleLogCount, setVisibleLogCount] = useState(INITIAL_LOG_LIMIT);
  const logRef = useRef(null);
  const followTailRef = useRef(true);
  const restoreScrollRef = useRef(null);
  const log = task.log || [];
  const hiddenLogCount = Math.max(0, log.length - visibleLogCount);
  const visibleLog = hiddenLogCount ? log.slice(hiddenLogCount) : log;
  const kindKey =
    {
      planner: "kind.planner",
      "workflow-node": "kind.step",
      "workflow-router": "kind.router",
      "agent-call": "kind.agentCall",
      workspace: "kind.workspace",
      resume: "kind.resume",
    }[task.kind] || "kind.agent";

  useLayoutEffect(() => {
    if (!open || !logRef.current) return;
    if (restoreScrollRef.current) {
      const { height, top } = restoreScrollRef.current;
      logRef.current.scrollTop = top + logRef.current.scrollHeight - height;
      restoreScrollRef.current = null;
    } else if (followTailRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log.length, open, visibleLogCount]);

  function toggleOpen() {
    setOpen((current) => {
      if (!current) followTailRef.current = true;
      return !current;
    });
  }

  function handleLogScroll(event) {
    const element = event.currentTarget;
    followTailRef.current =
      element.scrollHeight - element.scrollTop - element.clientHeight < 32;
  }

  function showOlderLogs() {
    if (logRef.current) {
      restoreScrollRef.current = {
        height: logRef.current.scrollHeight,
        top: logRef.current.scrollTop,
      };
    }
    followTailRef.current = false;
    setVisibleLogCount((count) => count + LOG_PAGE_SIZE);
  }

  return (
    <div className="task-card">
      <div className="task-head" onClick={toggleOpen}>
        <span className="task-title">
          <Badge
            variant="pending"
            uppercase={false}
            style={{ fontSize: 10, marginRight: 6 }}
          >
            {t(kindKey)}
          </Badge>
          {task.title}
        </span>
        <Badge variant={task.status}>{t(`status.${task.status}`)}</Badge>
      </div>
      {open && (
        <div className="task-log" ref={logRef} onScroll={handleLogScroll}>
          {hiddenLogCount > 0 && (
            <button
              className="log-show-older"
              type="button"
              onClick={showOlderLogs}
            >
              {t("run.log.showOlder", { count: hiddenLogCount })}
            </button>
          )}
          {visibleLog.length
            ? visibleLog.map((line, index) => (
                <div
                  key={`${task.id}-${hiddenLogCount + index}`}
                  className={`log-line ${getLogLineClass(line)}`}
                >
                  {line}
                </div>
              ))
            : t("run.noLog")}
        </div>
      )}
    </div>
  );
});

/** A resumed run re-runs some nodes, so one nodeId can have several tasks across attempts.
 * The canvas should reflect the latest attempt, not the first one still sitting in history. */
function latestTaskForNode(tasks, nodeId, kind) {
  for (let i = tasks.length - 1; i >= 0; i--) {
    const task = tasks[i];
    if (task.nodeId === nodeId && (!kind || task.kind === kind)) return task;
  }
  return null;
}

const RATE_LIMIT_LABEL = { five_hour: "5h", seven_day: "7d", weekly: "7d" };

/** Compact quota strip sitting right above the run's diagram/task list. Account-wide (not
 * per-run), so it's the same box regardless of which run is selected — see getUsageSummary() /
 * lastClaudeQuota in orchestrator.js for why Claude has real numbers and Codex never will. */
function QuotaStrip({ quota }) {
  const { t } = usePreferences();
  const claude = quota?.claude || null;
  const remainingPct = claude ? Math.max(0, Math.round((1 - (claude.utilization || 0)) * 100)) : null;

  return (
    <div className="run-quota-box">
      <div className="run-quota-row">
        <span className="run-quota-provider">
          <ProviderIcon provider="claude" size={14} title={t("agents.provider.claude")} />
          {t("agents.provider.claude")}
        </span>
        {claude ? (
          <>
            <div className="run-quota-bar-track">
              <div className="run-quota-bar-fill run-quota-bar-claude" style={{ width: `${remainingPct}%` }} />
            </div>
            <span className="run-quota-value">
              {t("usage.remaining")} {remainingPct}% ({RATE_LIMIT_LABEL[claude.rateLimitType] || claude.rateLimitType})
            </span>
            {claude.isUsingOverage && <span className="run-quota-warn">⚠️ {t("usage.overage")}</span>}
          </>
        ) : (
          <span className="run-quota-value run-quota-muted">{t("usage.quotaUnknown")}</span>
        )}
      </div>
      <div className="run-quota-row">
        <span className="run-quota-provider">
          <ProviderIcon provider="codex" size={14} title={t("agents.provider.codex")} />
          {t("agents.provider.codex")}
        </span>
        <span className="run-quota-value run-quota-muted">{t("usage.quotaCodexUnavailable")}</span>
      </div>
    </div>
  );
}

function filePatch(patch, filePath) {
  if (!patch) return "";
  const sections = patch.split(/(?=^diff --git )/m).filter(Boolean);
  return (
    sections.find((section) =>
      section.split("\n", 1)[0].endsWith(` b/${filePath}`),
    ) || patch
  );
}

function DiffLine({ line }) {
  const className = line.startsWith("+") && !line.startsWith("+++")
    ? "diff-add"
    : line.startsWith("-") && !line.startsWith("---")
      ? "diff-delete"
      : line.startsWith("@@")
        ? "diff-hunk"
        : line.startsWith("diff ") || line.startsWith("index ")
          ? "diff-meta"
          : "";
  return <span className={className}>{line || " "}</span>;
}

function RunReview({ review, busy, onAccept, onDecline }) {
  const { t } = usePreferences();
  const [selectedPath, setSelectedPath] = useState(review?.files?.[0]?.path || "");

  useEffect(() => {
    if (!review?.files?.some((file) => file.path === selectedPath)) {
      setSelectedPath(review?.files?.[0]?.path || "");
    }
  }, [review, selectedPath]);

  if (!review || review.status === "unavailable") {
    return review ? (
      <section className="run-review run-review-unavailable">
        <strong>{t("run.review.unavailable")}</strong>
        <span>{review.reason}</span>
      </section>
    ) : null;
  }
  if (review.status === "no_changes") {
    return <div className="run-review-empty">✓ {t("run.review.noChanges")}</div>;
  }

  const selectedFile = review.files?.find((file) => file.path === selectedPath);
  const selectedPatch = filePatch(review.patch, selectedPath);
  return (
    <section className="run-review">
      <div className="run-review-header">
        <div>
          <h3>{t("run.review.title")}</h3>
          <p>
            {t("run.review.summary", { count: review.files?.length || 0 })} · {review.baseBranch}
          </p>
        </div>
        <span className={`review-state review-state-${review.status}`}>
          {t(`run.review.status.${review.status}`)}
        </span>
        {review.status === "pending" && (
          <div className="run-review-actions">
            <Button variant="secondary" color="danger" disabled={busy} onClick={onDecline}>
              {t("run.review.decline")}
            </Button>
            <Button variant="primary" disabled={busy} onClick={onAccept}>
              {busy ? t("run.review.processing") : t("run.review.accept")}
            </Button>
          </div>
        )}
      </div>
      <div className="run-review-body">
        <div className="review-file-list">
          {review.files?.map((file) => (
            <button
              type="button"
              key={`${file.previousPath || ""}-${file.path}`}
              className={file.path === selectedPath ? "active" : ""}
              onClick={() => setSelectedPath(file.path)}
            >
              <span className={`review-file-status status-${file.status}`}>{file.status}</span>
              <span className="review-file-path">{file.path}</span>
              {file.additions !== null && (
                <span className="review-file-counts">
                  <b>+{file.additions}</b> <i>-{file.deletions}</i>
                </span>
              )}
            </button>
          ))}
        </div>
        <div className="review-diff">
          <div className="review-diff-title">{selectedFile?.path}</div>
          <pre>{selectedPatch.split("\n").map((line, index) => <DiffLine key={index} line={line} />)}</pre>
          {review.patchTruncated && <div className="review-truncated">{t("run.review.truncated")}</div>}
        </div>
      </div>
    </section>
  );
}

export default function RunTab({ view = "history" }) {
  const { t } = usePreferences();
  const navigate = useNavigate();
  const { runId } = useParams();
  const [agents, setAgents] = useState([]);
  const [workflows, setWorkflows] = useState([]);
  const [defaultCwd, setDefaultCwd] = useState("");
  const [runs, setRuns] = useState([]);
  const [selectedRunId, setSelectedRunId] = useState(null);
  const [selectedRun, setSelectedRun] = useState(null);
  // Account-wide, not tied to selectedRun — see QuotaStrip. Loaded once up front (shows
  // whatever was last captured from an earlier run) and refreshed as the selected run's tasks
  // finish, since that's when a fresh Claude rate_limit_event might have landed server-side.
  const [quota, setQuota] = useState(null);

  const [mode, setMode] = useState("workflow");
  const [prompt, setPrompt] = useState("");
  const [agentId, setAgentId] = useState("");
  const [workflowId, setWorkflowId] = useState("");
  const [decompose, setDecompose] = useState(false);
  const [cwd, setCwd] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [browsing, setBrowsing] = useState(false);
  // Separate from the form's `error`: a failed stop/resume belongs next to the run it happened
  // to, not under the "Run" button in the sidebar where nobody is looking.
  const [runActionError, setRunActionError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState(null); // run object pending delete, or "__all__"
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewDecision, setReviewDecision] = useState(null);
  const pendingLogsRef = useRef(new Map());
  const logFlushFrameRef = useRef(null);

  const flushPendingLogs = React.useCallback(() => {
    logFlushFrameRef.current = null;
    const pendingByRun = pendingLogsRef.current;
    pendingLogsRef.current = new Map();

    setSelectedRun((prev) => {
      if (!prev) return prev;
      const pendingByTask = pendingByRun.get(prev.id);
      if (!pendingByTask) return prev;

      let changed = false;
      const tasks = prev.tasks.map((task) => {
        const lines = pendingByTask.get(task.id);
        if (!lines?.length) return task;
        changed = true;
        return { ...task, log: [...(task.log || []), ...lines] };
      });
      return changed ? { ...prev, tasks } : prev;
    });
  }, []);

  const queueLog = React.useCallback(
    (evt) => {
      let pendingByTask = pendingLogsRef.current.get(evt.runId);
      if (!pendingByTask) {
        pendingByTask = new Map();
        pendingLogsRef.current.set(evt.runId, pendingByTask);
      }
      const lines = pendingByTask.get(evt.taskId) || [];
      lines.push(evt.line);
      pendingByTask.set(evt.taskId, lines);

      if (logFlushFrameRef.current === null) {
        logFlushFrameRef.current = requestAnimationFrame(flushPendingLogs);
      }
    },
    [flushPendingLogs],
  );

  useEffect(
    () => () => {
      if (logFlushFrameRef.current !== null) {
        cancelAnimationFrame(logFlushFrameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    api.meta().then((d) => {
      setDefaultCwd(d.defaultCwd);
      setCwd(d.defaultCwd);
    });
    api.listAgents().then((d) => {
      setAgents(d.agents);
      if (d.agents.length) setAgentId(d.agents[0].id);
    });
    api.listWorkflows().then((d) => {
      setWorkflows(d.workflows);
      if (d.workflows.length) setWorkflowId(d.workflows[0].id);
    });
    refreshRuns();
    loadQuota();
  }, []);

  useEffect(() => {
    if (view === "history" && runId) loadRun(runId);
  }, [runId, view]);

  useEffect(() => {
    if (view !== "new") return;
    setSelectedRunId(null);
    setSelectedRun(null);
    setRunActionError("");
    setReviewDecision(null);
    pendingLogsRef.current = new Map();
  }, [view]);

  function refreshRuns() {
    api.listRuns().then((d) => setRuns(d.runs));
  }

  function loadQuota() {
    api
      .getUsage()
      .then((d) => setQuota(d.quota))
      .catch(() => {});
  }

  function loadRun(id) {
    setSelectedRunId(id);
    api.getRun(id).then((d) => setSelectedRun(d.run));
  }

  const onEvent = React.useCallback(
    (evt) => {
      if (evt.type === "run-created") {
        refreshRuns();
        return;
      }
      // Covers deletes made from another browser tab too, not just this one — the delete
      // handlers below already do this locally before the request even round-trips, but a
      // second tab watching the same history needs the WS event to stay in sync.
      if (evt.type === "run-deleted") {
        refreshRuns();
        setSelectedRunId((prev) => (prev === evt.runId ? null : prev));
        setSelectedRun((prev) => (prev?.id === evt.runId ? null : prev));
        return;
      }
      if (evt.type === "runs-cleared") {
        refreshRuns();
        setSelectedRunId(null);
        setSelectedRun(null);
        return;
      }
      if (!selectedRunId || evt.runId !== selectedRunId) return;

      // CLI output often arrives in bursts. Commit at most once per paint so a busy process
      // does not force React to clone and reconcile the whole run for every individual line.
      if (evt.type === "log") {
        queueLog(evt);
        return;
      }

      // Preserve wire order at task/run boundaries. In particular, flush the last output burst
      // before a terminal status triggers getRun(), otherwise the fetched snapshot and a later
      // animation-frame flush could append the same tail twice.
      if (pendingLogsRef.current.size) {
        if (logFlushFrameRef.current !== null) {
          cancelAnimationFrame(logFlushFrameRef.current);
        }
        flushPendingLogs();
      }

      // A run reaching a terminal status changes more than the badge — whether it can be
      // resumed is computed server side, so re-read the run rather than guessing locally.
      if (evt.type === "run-status" && evt.status !== "running") {
        api
          .getRun(evt.runId)
          .then((d) => setSelectedRun(d.run))
          .catch(() => {});
      }
      if (evt.type === "review-status") {
        api
          .getRun(evt.runId)
          .then((d) => setSelectedRun(d.run))
          .catch(() => {});
        refreshRuns();
      }

      // A task finishing is the moment a fresh Claude rate_limit_event may have landed
      // server-side (see runClaudeProcess) — re-pull the account-wide quota then, not on every
      // log line, so the strip in the UI stays current without hammering the endpoint.
      if (evt.type === "task-status" && ["done", "error", "cancelled"].includes(evt.status)) {
        loadQuota();
      }

      setSelectedRun((prev) => {
        if (!prev) return prev;

        if (evt.type === "task-created") {
          return {
            ...prev,
            tasks: [...prev.tasks, { ...evt.task, log: evt.task.log || [] }],
          };
        }
        if (evt.type === "task-status") {
          return {
            ...prev,
            tasks: prev.tasks.map((task) =>
              task.id === evt.taskId
                ? { ...task, status: evt.status }
                : task,
            ),
          };
        }
        if (evt.type === "run-status") {
          refreshRuns();
          return { ...prev, status: evt.status };
        }
        return prev;
      });
    },
    [flushPendingLogs, queueLog, selectedRunId],
  );

  useWebSocket(onEvent);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!prompt.trim()) return;
    setError("");
    setSubmitting(true);
    try {
      const data =
        mode === "agent"
          ? await api.runAgent({ prompt, agentId, decompose, cwd })
          : await api.runWorkflow({ prompt, workflowId, cwd });
      setPrompt("");
      loadQuota();
      navigate(`/run/${data.runId}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleStop() {
    if (!selectedRun) return;
    setRunActionError("");
    // Optimistic: the run stays "running" until its loop finishes unwinding (which can take a
    // moment while worktrees are cleaned up), so flip the button to "stopping" right away
    // instead of leaving it looking like the click did nothing.
    setSelectedRun((prev) => (prev ? { ...prev, stopping: true } : prev));
    try {
      await api.stopRun(selectedRun.id);
    } catch (err) {
      setRunActionError(err.message);
      setSelectedRun((prev) => (prev ? { ...prev, stopping: false } : prev));
    }
  }

  async function handleResume() {
    if (!selectedRun) return;
    setRunActionError("");
    try {
      await api.resumeRun(selectedRun.id);
      loadRun(selectedRun.id);
      refreshRuns();
    } catch (err) {
      setRunActionError(err.message);
    }
  }

  async function handleReviewDecision(decision) {
    if (!selectedRun || reviewBusy) return;
    setReviewDecision(null);
    setReviewBusy(true);
    setRunActionError("");
    try {
      const data = decision === "accept"
        ? await api.acceptRunReview(selectedRun.id)
        : await api.declineRunReview(selectedRun.id);
      setSelectedRun(data.run);
      refreshRuns();
    } catch (err) {
      setRunActionError(err.message);
    } finally {
      setReviewBusy(false);
    }
  }

  async function confirmDeleteRun() {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    try {
      if (target === "__all__") {
        await api.clearRuns();
      } else {
        await api.deleteRun(target.id);
        if (selectedRunId === target.id) {
          setSelectedRunId(null);
          setSelectedRun(null);
        }
      }
      refreshRuns();
    } catch (err) {
      setError(err.message);
    }
  }

  const deleteBlocked =
    deleteTarget &&
    deleteTarget !== "__all__" &&
    (deleteTarget.status === "running" || deleteTarget.review?.status === "pending");
  const deleteBlockedReason = deleteTarget?.review?.status === "pending"
    ? t("run.review.deleteBlocked")
    : t("run.deleteBlockedReason");

  const currentAgent = agents.find((a) => a.id === agentId);
  const currentWorkflow = workflows.find((w) => w.id === workflowId);

  return (
    <div className={`app run-${view}-view`}>
      {view === "new" && <div className="sidebar">
        <div className="run-config-header">
          <button type="button" className="run-back-link" onClick={() => navigate("/run")}>
            <span aria-hidden="true">←</span>
            {t("common.back")}
          </button>
          <p className="sidebar-section-title">{t("run.config")}</p>
        </div>
        <form className="run-form" onSubmit={handleSubmit}>
          <SegmentedControl
            options={[
              { value: "workflow", label: t("run.mode.workflow") },
              { value: "agent", label: t("run.mode.agent") },
            ]}
            value={mode}
            onChange={setMode}
          />

          <div className="run-field run-field-prompt">
            <label htmlFor="run-prompt">{t("run.prompt")}</label>
            <textarea
              id="run-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={t("run.prompt.placeholder")}
            />
          </div>

          {mode === "agent" ? (
            <div className="run-field">
              <label htmlFor="run-agent">{t("run.agent")}</label>
              <select
                id="run-agent"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.readOnly ? ` (${t("common.readOnly")})` : ""}
                  </option>
                ))}
              </select>
              {currentAgent && (
                <HelperText>{currentAgent.description}</HelperText>
              )}

              <CheckboxField
                id="decompose"
                checked={decompose}
                onChange={setDecompose}
                label={t("run.decompose")}
              />
            </div>
          ) : (
            <div className="run-field">
              <label htmlFor="run-workflow">{t("run.workflow")}</label>
              <select
                id="run-workflow"
                value={workflowId}
                onChange={(e) => setWorkflowId(e.target.value)}
              >
                {workflows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
              {currentWorkflow && (
                <HelperText>{currentWorkflow.description}</HelperText>
              )}
              {!workflows.length && (
                <HelperText>{t("run.noWorkflow")}</HelperText>
              )}
            </div>
          )}

          <div className="run-field">
            <label htmlFor="run-cwd">{t("run.cwd")}</label>
            <div className="cwd-row">
              <input
                id="run-cwd"
                type="text"
                value={cwd}
                onChange={(e) => setCwd(e.target.value)}
                placeholder={defaultCwd}
                title={cwd || defaultCwd}
              />
              <Button
                variant="secondary"
                type="button"
                onClick={() => setBrowsing(true)}
              >
                {t("run.browse")}
              </Button>
            </div>
          </div>

          <ErrorBox>{error}</ErrorBox>

          <Button
            variant="primary"
            type="submit"
            disabled={
              submitting ||
              !prompt.trim() ||
              (mode === "workflow" && !workflowId)
            }
          >
            {!submitting && <IconPlay size={13} />}
            {submitting ? t("run.submitting") : t("common.run")}
          </Button>
        </form>
      </div>}

      {view === "history" && <aside className="run-history-panel">
        <div className="run-list">
          <div className="run-list-header">
            <div className="run-list-heading">
              <span>{t("run.history")}</span>
              <b>{runs.length}</b>
            </div>
            <div className="run-list-actions">
              {runs.length > 1 && (
                <Button
                  variant="icon"
                  title={t("run.clearAll")}
                  onClick={() => setDeleteTarget("__all__")}
                >
                  <IconTrash size={13} />
                </Button>
              )}
              <Button className="new-run-btn" onClick={() => navigate("/run/new")}>
                {t("run.new")}
              </Button>
            </div>
          </div>
          {runs.map((r) => (
            <div
              key={r.id}
              className={`run-item ${r.id === selectedRunId ? "active" : ""}`}
              onClick={() => navigate(`/run/${r.id}`)}
            >
              <div className="run-item-top">
                <Badge variant={r.status} className="status">
                  {t(`status.${r.status}`)}
                </Badge>
                <Button
                  variant="icon"
                  className="run-item-delete"
                  title={
                    r.status === "running"
                      ? t("run.deleteBlockedTooltip")
                      : r.review?.status === "pending"
                        ? t("run.review.deleteBlocked")
                      : t("run.delete")
                  }
                  onClick={(e) => {
                    e.stopPropagation();
                    setDeleteTarget(r);
                  }}
                >
                  <IconTrash size={12} />
                </Button>
              </div>
              <div className="run-item-prompt">{r.prompt.slice(0, 60)}</div>
            </div>
          ))}
        </div>
      </aside>}

      {deleteTarget && (
        <ConfirmModal
          title={t("run.delete")}
          message={
            deleteTarget === "__all__"
              ? t("run.confirmClearAll")
              : t("run.confirmDelete")
          }
          blocked={deleteBlocked}
          reason={deleteBlocked ? deleteBlockedReason : ""}
          onConfirm={confirmDeleteRun}
          onClose={() => setDeleteTarget(null)}
        />
      )}

      {reviewDecision === "decline" && (
        <ConfirmModal
          title={t("run.review.decline")}
          message={t("run.review.confirmDecline")}
          onConfirm={() => handleReviewDecision("decline")}
          onClose={() => setReviewDecision(null)}
        />
      )}

      <div className="main">
        {view === "new" && mode === "workflow" && currentWorkflow && (
          <div className="process-preview">
            <div className="process-preview-title">
              {t("run.preview.title", { name: currentWorkflow.name })}
            </div>
            <WorkflowCanvas
              readOnly
              nodes={currentWorkflow.nodes.map((n) => ({
                id: n.id,
                title: agents.find((a) => a.id === n.agentId)?.name || "?",
                subtitle: n.kind === "router" ? t("kind.router") : "",
                kind: n.kind,
                provider:
                  agents.find((a) => a.id === n.agentId)?.provider || "claude",
                x: n.x,
                y: n.y,
              }))}
              edges={currentWorkflow.edges}
              callEdges={currentWorkflow.nodes.flatMap((n) =>
                (n.calleeNodeIds || []).map((to) => ({ from: n.id, to })),
              )}
            />
            <div className="empty-state-sub">{t("run.preview.hint")}</div>
          </div>
        )}
        {((view === "history" && !selectedRun) ||
          (view === "new" && !(mode === "workflow" && currentWorkflow))) && (
          <div className="empty-state">
            <div className="empty-state-icon">▶</div>
            {t("run.empty")}
          </div>
        )}
        {view === "history" && selectedRun && (
          <>
            <div className="run-header">
              <div className="prompt">{selectedRun.prompt}</div>
              <div className="meta">
                {selectedRun.workflowId
                  ? t("run.meta.workflow")
                  : t("run.meta.agent", { id: selectedRun.agentId })}{" "}
                ·{" "}
                {selectedRun.decompose
                  ? t("run.meta.multi")
                  : t("run.meta.single")}{" "}
                ·{" "}
                <Badge variant={selectedRun.status}>
                  {t(`status.${selectedRun.status}`)}
                </Badge>
                {selectedRun.status === "running" && (
                  <Button
                    variant="secondary"
                    color="danger"
                    className="run-header-action run-header-stop"
                    disabled={selectedRun.stopping}
                    onClick={handleStop}
                    title={t("run.stop.hint")}
                  >
                    {selectedRun.stopping ? t("run.stopping") : t("run.stop")}
                  </Button>
                )}
                {selectedRun.resumable && (
                  <Button
                    variant="secondary"
                    className="run-header-action"
                    onClick={handleResume}
                    title={t("run.resume.hint")}
                  >
                    {t("run.resume")}
                  </Button>
                )}
              </div>
              <ErrorBox>{runActionError}</ErrorBox>
            </div>
            <QuotaStrip quota={quota} />
            <RunReview
              review={selectedRun.review}
              busy={reviewBusy}
              onAccept={() => handleReviewDecision("accept")}
              onDecline={() => setReviewDecision("decline")}
            />
            {selectedRun.workflowId && selectedRun.workflowNodes && (
              <WorkflowCanvas
                readOnly
                nodes={selectedRun.workflowNodes.map((n) => {
                  const task = latestTaskForNode(selectedRun.tasks, n.id);
                  const agent = agents.find((a) => a.id === n.agentId);
                  return {
                    id: n.id,
                    title: agent?.name || n.agentId,
                    subtitle: task
                      ? task.status === "running"
                        ? t("status.runningNow")
                        : t(`status.${task.status}`)
                      : n.kind === "router"
                        ? t("kind.router")
                        : "",
                    status: task?.status,
                    kind: n.kind,
                    provider: agent?.provider || "claude",
                    x: n.x,
                    y: n.y,
                  };
                })}
                edges={selectedRun.workflowEdges.map((e) => ({
                  ...e,
                  status: latestTaskForNode(selectedRun.tasks, e.to)?.status,
                }))}
                callEdges={selectedRun.workflowNodes.flatMap((n) =>
                  (n.calleeNodeIds || []).map((to) => ({
                    from: n.id,
                    to,
                    status: latestTaskForNode(
                      selectedRun.tasks,
                      to,
                      "agent-call",
                    )?.status,
                  })),
                )}
              />
            )}
            {selectedRun.tasks.map((task) => (
              <TaskCard key={task.id} task={task} />
            ))}
          </>
        )}
      </div>

      {browsing && (
        <DirBrowserModal
          startPath={cwd || defaultCwd}
          onSelect={(p) => {
            setCwd(p);
            setBrowsing(false);
          }}
          onClose={() => setBrowsing(false)}
        />
      )}
    </div>
  );
}
