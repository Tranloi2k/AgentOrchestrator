import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../../shared/api.js";
import WorkflowCanvas from "../workflows/WorkflowCanvas.jsx";
import TeamDiagram, { teamFromNodes } from "../workflows/team/TeamDiagram.jsx";
import DirBrowserModal from "../../shared/components/DirBrowserModal.jsx";
import { IconPlay, IconTrash, ProviderIcon } from "../../shared/Icons.jsx";
import { usePreferences } from "../../app/PreferencesContext.jsx";
import { nodeDisplay, callEdgesOf } from "../workflows/workflowDisplay.js";
import RunChatBox from "./RunChatBox.jsx";
import BranchPicker from "./BranchPicker.jsx";
import ReviewPanel from "./ReviewPanel.jsx";
import {
  Badge,
  Button,
  CheckboxField,
  ConfirmModal,
  ErrorBox,
  HelperText,
  SegmentedControl,
} from "../../shared/components/index.js";

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

/** Same token count the server's spawn budget uses: input + output + cache writes. */
function spawnTokens(task) {
  const u = task.usage;
  return u ? (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheCreationTokens || 0) : 0;
}

/** One line under a spawned agent's title: what it runs on, what it may use, who created it. */
function SpawnMeta({ task, parentTitle }) {
  const { t } = usePreferences();
  const s = task.spawn;
  const level = t(`agents.access.${s.accessLevel || "read"}`);
  const access =
    s.provider !== "claude"
      ? level
      : `${level} · ${s.tools?.length ? t("run.spawn.tools", { tools: s.tools.join(", ") }) : t("run.spawn.noTools")}`;
  return (
    <div className="task-spawn-meta">
      <ProviderIcon provider={s.provider} size={13} title={t(`agents.provider.${s.provider}`)} />
      <span>{s.model || t("run.spawn.defaultModel")}</span>
      <span>· {access}</span>
      {parentTitle && <span>· {t("run.spawn.by", { name: parentTitle })}</span>}
      {task.usage && <span>· {t("run.spawn.tokens", { count: spawnTokens(task).toLocaleString() })}</span>}
    </div>
  );
}

const TaskCard = React.memo(function TaskCard({ task, parentTitle, onDeleteTurn }) {
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
      "agent-spawn": "kind.spawn",
      followup: "kind.followup",
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
        {onDeleteTurn && (
          <button
            type="button"
            className="task-delete"
            title={t("run.chat.deleteTurn")}
            aria-label={t("run.chat.deleteTurn")}
            onClick={(e) => {
              e.stopPropagation();
              onDeleteTurn();
            }}
          >
            <IconTrash size={12} />
          </button>
        )}
      </div>
      {task.spawn && <SpawnMeta task={task} parentTitle={parentTitle} />}
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

/** Run-level tally of spawn_agent use against the supervisor's limits (taken from the latest
 * spawned task, which records the limits it was created under). Hidden when nothing was spawned. */
function SpawnSummary({ tasks }) {
  const { t } = usePreferences();
  const spawned = tasks.filter((task) => task.kind === "agent-spawn");
  if (!spawned.length) return null;
  const limits = spawned[spawned.length - 1].spawn?.limits || {};
  const tokens = spawned.reduce((sum, task) => sum + spawnTokens(task), 0);
  const running = spawned.filter((task) => task.status === "running").length;
  return (
    <div className="run-spawn-summary">
      🧬{" "}
      {t("run.spawn.summary", {
        count: spawned.length,
        max: limits.maxAgents ?? "?",
        tokens: tokens.toLocaleString(),
        budget: limits.tokenBudget ? limits.tokenBudget.toLocaleString() : "∞",
      })}
      {running > 0 && <span> · {t("run.spawn.running", { count: running })}</span>}
    </div>
  );
}

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
  // Where the run's code lands on Accept: { branch, newBranch } — see BranchPicker.
  const [target, setTarget] = useState({ branch: "", newBranch: "" });
  // Values for the selected workflow's {{input.x}} placeholders.
  const [inputValues, setInputValues] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [browsing, setBrowsing] = useState(false);
  // Separate from the form's `error`: a failed stop/resume belongs next to the run it happened
  // to, not under the "Run" button in the sidebar where nobody is looking.
  const [runActionError, setRunActionError] = useState("");
  // A follow-up task (delete that turn) or "__all__" (delete the whole chat), awaiting confirmation.
  const [deleteChatTarget, setDeleteChatTarget] = useState(null);
  // The task list scrolls in its own box; it follows new tasks while you're at its bottom.
  const taskListRef = useRef(null);
  const followTasksRef = useRef(true);
  const taskCount = selectedRun?.tasks?.length || 0;
  useLayoutEffect(() => {
    const el = taskListRef.current;
    if (el && followTasksRef.current) el.scrollTop = el.scrollHeight;
  }, [taskCount, selectedRun?.id]);
  useEffect(() => {
    followTasksRef.current = true;
  }, [selectedRun?.id]);
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
      if (evt.type === "run-updated") {
        api
          .getRun(evt.runId)
          .then((d) => setSelectedRun((prev) => (prev?.id === evt.runId ? d.run : prev)))
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
                ? { ...task, status: evt.status, ...(evt.usage ? { usage: evt.usage } : {}) }
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
          ? await api.runAgent({ prompt, agentId, decompose, cwd, targetBranch: target.branch, newBranch: target.newBranch })
          : await api.runWorkflow({ prompt, workflowId, cwd, targetBranch: target.branch, newBranch: target.newBranch, inputs: inputValues });
      if (target.newBranch.trim()) setTarget({ branch: target.newBranch.trim(), newBranch: "" });
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

  async function confirmDeleteChat() {
    const target = deleteChatTarget;
    setDeleteChatTarget(null);
    if (!selectedRun || !target) return;
    setRunActionError("");
    try {
      const { run } = await api.deleteChat(selectedRun.id, target === "__all__" ? null : target.id);
      setSelectedRun(run);
    } catch (err) {
      setRunActionError(err.message);
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
                    {` (${t(`agents.access.${a.accessLevel || "write"}`)})`}
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

          {mode === "workflow" &&
            (currentWorkflow?.inputs || [])
              .filter((inp) => inp.name)
              .map((inp) => (
                <div className="run-field" key={inp.name}>
                  <label htmlFor={`run-input-${inp.name}`}>
                    {inp.label || inp.name}
                    {inp.required ? " *" : ""}
                  </label>
                  <input
                    id={`run-input-${inp.name}`}
                    type="text"
                    value={inputValues[inp.name] ?? ""}
                    placeholder={inp.default}
                    onChange={(e) => setInputValues((v) => ({ ...v, [inp.name]: e.target.value }))}
                  />
                </div>
              ))}

          <BranchPicker cwd={cwd || defaultCwd} value={target} onChange={setTarget} />

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
              <div className="run-item-prompt">
                {r.trigger?.type === "schedule" && <span title={t("run.trigger.schedule", { cron: r.trigger.cron })}>⏰ </span>}
                {r.prompt.slice(0, 60)}
              </div>
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

      {deleteChatTarget && (
        <ConfirmModal
          title={deleteChatTarget === "__all__" ? t("run.chat.clear") : t("run.chat.deleteTurn")}
          message={t(deleteChatTarget === "__all__" ? "run.chat.confirmClear" : "run.chat.confirmDeleteTurn")}
          onConfirm={confirmDeleteChat}
          onClose={() => setDeleteChatTarget(null)}
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
            {currentWorkflow.type === "team" ? (
              <TeamDiagram {...teamFromNodes(currentWorkflow.nodes)} agents={agents} />
            ) : (
            <WorkflowCanvas
              readOnly
              nodes={currentWorkflow.nodes.map((n) => ({
                id: n.id,
                ...nodeDisplay(n, agents, t),
                kind: n.kind,
                x: n.x,
                y: n.y,
              }))}
              edges={currentWorkflow.edges}
              callEdges={callEdgesOf(currentWorkflow.nodes)}
            />
            )}
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
                {selectedRun.targetBranch && (
                  <>
                    · <span className="run-meta-branch">⎇ {selectedRun.targetBranch}</span>{" "}
                  </>
                )}
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
            <ReviewPanel
              review={selectedRun.review}
              busy={reviewBusy}
              onAccept={() => handleReviewDecision("accept")}
              onDecline={() => setReviewDecision("decline")}
            />
            <div className="run-detail">
              <div
                className="run-detail-main"
                ref={taskListRef}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  followTasksRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
                }}
              >
                <SpawnSummary tasks={selectedRun.tasks} />
                {selectedRun.tasks.map((task) => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    parentTitle={
                      task.spawnedByTaskId
                        ? selectedRun.tasks.find((p) => p.id === task.spawnedByTaskId)?.title?.slice(0, 60)
                        : undefined
                    }
                    onDeleteTurn={
                      task.kind === "followup" && selectedRun.status !== "running" ? () => setDeleteChatTarget(task) : undefined
                    }
                  />
                ))}
              </div>
              <aside className="run-detail-side">
                {selectedRun.workflowId && selectedRun.workflowNodes && (
                  <div className="run-detail-diagram">
                    {selectedRun.workflowType === "team" ? (
                      <TeamDiagram
                        {...teamFromNodes(selectedRun.workflowNodes)}
                        agents={agents}
                        compact
                        statusOf={(nodeId) => latestTaskForNode(selectedRun.tasks, nodeId)?.status}
                        spawnCount={selectedRun.tasks.filter((task) => task.kind === "agent-spawn").length}
                      />
                    ) : (
                    <WorkflowCanvas
                      readOnly
                      nodes={selectedRun.workflowNodes.map((n) => {
                        const task = latestTaskForNode(selectedRun.tasks, n.id);
                        const display = nodeDisplay(n, agents, t);
                        return {
                          id: n.id,
                          ...display,
                          subtitle: task
                            ? task.status === "running"
                              ? t("status.runningNow")
                              : t(`status.${task.status}`)
                            : display.subtitle,
                          status: task?.status,
                          kind: n.kind,
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
                  </div>
                )}
                <RunChatBox
                  run={selectedRun}
                  agents={agents}
                  onSent={() => {
                    loadRun(selectedRun.id);
                    refreshRuns();
                  }}
                  onStop={handleStop}
                  onClearChat={() => setDeleteChatTarget("__all__")}
                />
              </aside>
            </div>
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
