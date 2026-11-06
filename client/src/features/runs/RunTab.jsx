import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../../shared/api.js";
import WorkflowCanvas from "../workflows/WorkflowCanvas.jsx";
import TeamDiagram, { teamFromNodes, blueprintStatus, teamFlow, teamRunOutcome } from "../workflows/team/TeamDiagram.jsx";
import DirBrowserModal from "../../shared/components/DirBrowserModal.jsx";
import { IconCheck, IconCopy, IconEdit, IconPlay, IconTrash, ProviderIcon } from "../../shared/Icons.jsx";
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
  ContextMenu,
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

const STATUS_LINE_PREFIXES = [
  ["❌", "error"],
  ["⚠️", "warning"],
  ["🔧", "tool"],
  ["✅", "success"],
  ["ℹ️", "info"],
];

const isDiffStart = (line) => /^(--- |\+\+\+ |@@|diff --git )/.test(line);
const isDiffLine = (line) => /^([+\- ]|@@|diff --git |--- |\+\+\+ )/.test(line);

/**
 * Groups raw log lines into blocks so agent output reads like a document: fenced code and bare
 * diffs become code blocks, markdown headings become headings, status lines (🔧, ℹ️, ❌…) keep
 * their own style, and everything else is prose.
 */
function groupLogLines(lines) {
  const blocks = [];
  let code = null; // { lang, lines, fenced }

  const closeCode = () => {
    if (code) blocks.push({ type: "code", lang: code.lang, lines: code.lines });
    code = null;
  };

  for (const raw of lines) {
    const line = raw ?? "";
    const fence = line.trimStart().match(/^```(\S*)/);
    if (code?.fenced) {
      if (fence) closeCode();
      else code.lines.push(line);
      continue;
    }
    if (fence) {
      closeCode();
      code = { lang: fence[1], lines: [], fenced: true };
      continue;
    }
    if (code && isDiffLine(line)) {
      code.lines.push(line);
      continue;
    }
    closeCode();
    if (isDiffStart(line)) {
      code = { lang: "diff", lines: [line], fenced: false };
      continue;
    }

    const status = STATUS_LINE_PREFIXES.find(([prefix]) => line.startsWith(prefix));
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (status) blocks.push({ type: status[1], text: line });
    else if (heading) blocks.push({ type: "heading", text: heading[1] });
    else if (!line.trim()) {
      if (blocks.length && blocks[blocks.length - 1].type !== "blank") blocks.push({ type: "blank" });
    } else blocks.push({ type: "text", text: line });
  }
  closeCode();
  return blocks;
}

/** `code` and **bold** inside a prose line; everything else stays plain text. */
function renderInline(text) {
  return text.split(/(`[^`]+`)/g).map((part, i) => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      return (
        <code key={i} className="log-inline-code">
          {part.slice(1, -1)}
        </code>
      );
    }
    return part.split(/(\*\*[^*]+\*\*)/g).map((piece, j) =>
      piece.length > 4 && piece.startsWith("**") && piece.endsWith("**") ? (
        <strong key={`${i}-${j}`}>{piece.slice(2, -2)}</strong>
      ) : (
        piece
      ),
    );
  });
}

function codeLineClass(line, isDiff) {
  if (!isDiff) return "";
  if (/^(--- |\+\+\+ |@@|diff --git )/.test(line)) return "code-meta";
  if (line.startsWith("+")) return "code-add";
  if (line.startsWith("-")) return "code-del";
  return "";
}

function LogBlock({ block }) {
  switch (block.type) {
    case "code": {
      const isDiff = block.lang === "diff" || block.lines.some((l) => l.startsWith("@@"));
      return (
        <pre className="log-code">
          {block.lines.map((line, i) => (
            <span key={i} className={`log-code-line ${codeLineClass(line, isDiff)}`.trim()}>
              {line || " "}
            </span>
          ))}
        </pre>
      );
    }
    case "heading":
      return <div className="log-heading">{renderInline(block.text)}</div>;
    case "blank":
      return <div className="log-blank" />;
    case "text":
      return <div className="log-text">{renderInline(block.text)}</div>;
    default:
      return <div className={`log-status log-${block.type}`}>{block.text}</div>;
  }
}

/** Same token count the server's spawn budget uses: input + output + cache writes. */
function spawnTokens(task) {
  const u = task.usage;
  return u ? (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheCreationTokens || 0) : 0;
}

/** Spawned agents as the server's maxAgents counts them: a named agent once per parallel copy, an ad-hoc spawn per call. */
function spawnedAgentCount(tasks) {
  const keys = tasks.filter((x) => x.kind === "agent-spawn").map((x) => (x.spawn?.blueprint ? `${x.spawn.blueprint}#${x.spawn.instance || 1}` : x.id));
  return new Set(keys).size;
}

/** One line under a spawned agent's title: what it runs on, what it may use, who created it. */
function SpawnMeta({ task, parentTitle }) {
  const { t } = usePreferences();
  const s = task.spawn;
  const level = t(`agents.access.${s.accessLevel || "read"}`);
  const access =
    s.provider !== "claude" || s.blueprint
      ? level
      : `${level} · ${s.tools?.length ? t("run.spawn.tools", { tools: s.tools.join(", ") }) : t("run.spawn.noTools")}`;
  // A blueprint spawn shows its role, then the provider that actually ran (or the order it will try).
  const provider = s.provider || (s.blueprint ? null : "claude");
  return (
    <div className="task-spawn-meta">
      {s.blueprint && (
        <span title={s.inline ? s.role || "" : ""}>
          🧬 {t(s.inline ? "run.spawn.inline" : "run.spawn.blueprint", { name: s.blueprint })}
          {task.workItemId ? ` [${task.workItemId}]` : ""} ·
        </span>
      )}
      {provider ? (
        <>
          <ProviderIcon provider={provider} size={13} title={t(`agents.provider.${provider}`)} />
          <span>{s.blueprint ? t(`agents.provider.${provider}`) : ""} {s.model || t("run.spawn.defaultModel")}</span>
        </>
      ) : (
        <span>{t("run.spawn.providerOrder", { providers: (s.providers || []).map((x) => t(`agents.provider.${x}`)).join(" → ") })}</span>
      )}
      <span>· {access}</span>
      {parentTitle && <span>· {t("run.spawn.by", { name: parentTitle })}</span>}
      {task.usage && <span>· {t("run.spawn.tokens", { count: spawnTokens(task).toLocaleString() })}</span>}
    </div>
  );
}

/** What an outcome on task.fallbackLog means, for its tooltip: "done", a failure reason, or "skipped:<reason>". */
const outcomeReason = (outcome) => (outcome.startsWith("skipped:") ? outcome.slice(8) : outcome);

/**
 * The agents or providers a call left before one did the work (task.fallbackLog, set by the
 * server for team members and blueprint spawns), as one line: "agy: tool_denied, switched to
 * Claude". Hidden when the first one did it.
 */
function FallbackLine({ task }) {
  const { t } = usePreferences();
  const log = task.fallbackLog || [];
  if (!log.some((e) => e.outcome !== "done")) return null;
  // A blueprint's entries differ by provider; a member's by agent (two may share a provider).
  const name = (e) => (task.spawn?.blueprint ? t(`agents.provider.${e.provider}`) : e.agentName || t(`agents.provider.${e.provider}`));
  const parts = log.map((e, i) => {
    if (e.outcome === "done") return null;
    const reason = outcomeReason(e.outcome);
    const next = log.slice(i + 1).find((x) => !x.outcome.startsWith("skipped:"));
    const key = e.outcome.startsWith("skipped:") ? "run.fallback.skipped" : next ? "run.fallback.switched" : "run.fallback.failed";
    return (
      <span key={i} title={t(`run.failure.${reason}`)}>
        {t(key, { from: name(e), reason, to: next ? name(next) : "" })}
      </span>
    );
  });
  return <div className="task-fallback">🔀 {parts.filter(Boolean).reduce((acc, part, i) => (i ? [...acc, "; ", part] : [part]), [])}</div>;
}

const TaskCard = React.memo(function TaskCard({ task, parentTitle, onDeleteTurn, firstMessage }) {
  const { t } = usePreferences();
  const [open, setOpen] = useState(true);
  const [visibleLogCount, setVisibleLogCount] = useState(INITIAL_LOG_LIMIT);
  const logRef = useRef(null);
  const followTailRef = useRef(true);
  const restoreScrollRef = useRef(null);
  const log = task.log || [];
  const hiddenLogCount = Math.max(0, log.length - visibleLogCount);
  const visibleLog = hiddenLogCount ? log.slice(hiddenLogCount) : log;
  const logBlocks = useMemo(() => groupLogLines(visibleLog), [visibleLog]);
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

  // What the user typed: the run prompt on the first lead task, or a chat turn's message (older
  // turns only kept it as the title).
  const isTurn = task.kind === "followup";
  const chatMessage = isTurn ? task.userMessage || task.title : firstMessage || null;

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
    <div className={`task-card kind-${task.kind || "agent"} status-${task.status}`} id={`task-${task.id}`}>
      <div className="task-head" onClick={toggleOpen}>
        <span className="kind-chip">{t(kindKey)}</span>
        {/* A chat turn shows its whole message below instead of a cut-off title. */}
        <span className="task-title">{isTurn ? "" : task.title}</span>
        <Badge variant={task.status}>{t(`status.${task.status}`)}</Badge>
        {chatMessage && <CopyButton text={chatMessage} />}
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
      {chatMessage && (
        <div className="task-message">
          <RunPrompt text={chatMessage} />
        </div>
      )}
      {task.spawn && <SpawnMeta task={task} parentTitle={parentTitle} />}
      <FallbackLine task={task} />
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
          {logBlocks.length ? (
            logBlocks.map((block, index) => <LogBlock key={`${task.id}-${hiddenLogCount}-${index}`} block={block} />)
          ) : (
            <div className="log-empty">{t("run.noLog")}</div>
          )}
        </div>
      )}
    </div>
  );
});

/** One metric tile: label, value against its limit (if any) and a thin progress bar. */
function RunStat({ label, value, max, note, className = "" }) {
  const hasLimit = typeof max === "number" && max > 0;
  const ratio = hasLimit ? Math.min(1, value / max) : 0;
  const level = !hasLimit ? "" : ratio >= 1 ? "is-full" : ratio >= 0.8 ? "is-high" : "";
  return (
    <div className={["run-stat", level, className].filter(Boolean).join(" ")}>
      <div className="run-stat-label">
        {label}
        {note && <span className="run-stat-note">{note}</span>}
      </div>
      <div className="run-stat-value">
        {typeof value === "number" ? value.toLocaleString() : value}
        {typeof value === "number" && <span className="run-stat-max"> / {hasLimit ? max.toLocaleString() : "∞"}</span>}
      </div>
      {hasLimit && (
        <div className="run-stat-bar">
          <div className="run-stat-bar-fill" style={{ width: `${Math.round(ratio * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

/**
 * A run's usage against its limits, as columns of one card: a Team run's hand-offs and token budget
 * (server: teamLimitSummary), and spawn_agent use against the supervisor's limits (taken from the
 * latest spawned task, which records the limits it was created under). Hidden when neither applies.
 */
function RunStats({ usage, tasks }) {
  const { t } = usePreferences();
  const spawned = tasks.filter((task) => task.kind === "agent-spawn");
  if (!usage && !spawned.length) return null;
  // Work the coordinator handed out (members and spawned agents): what maxParallel counts.
  const handOffs = tasks.filter((task) => task.kind === "agent-call" || task.kind === "agent-spawn");
  const waiting = usage ? handOffs.filter((task) => task.status === "pending").length : 0;

  const full = usage && (usage.delegations >= usage.maxDelegations || (usage.runTokenBudget > 0 && usage.tokens >= usage.runTokenBudget));
  const limits = spawned.length ? spawned[spawned.length - 1].spawn?.limits || {} : {};
  const spawnTokenTotal = spawned.reduce((sum, task) => sum + spawnTokens(task), 0);
  const running = spawned.filter((task) => task.status === "running").length;

  return (
    <div className="run-stats-wrap">
      <div className="run-stats-card">
        <div className="run-stats">
          {usage && (
            <>
              <RunStat label={t("run.stats.handoffs")} value={usage.delegations} max={usage.maxDelegations} />
              <RunStat label={t("run.stats.runTokens")} value={usage.tokens} max={usage.runTokenBudget} />
              <RunStat label={t("run.stats.callTimeout")} value={t("run.stats.callTimeoutValue", { minutes: usage.callTimeoutMinutes })} />
              {usage.maxParallel > 0 && (
                <RunStat
                  label={t("run.stats.parallel")}
                  value={handOffs.filter((task) => task.status === "running").length}
                  max={usage.maxParallel}
                  note={waiting > 0 ? t("run.stats.waiting", { count: waiting }) : null}
                />
              )}
            </>
          )}
          {spawned.length > 0 && (
            <>
              <RunStat
                className={usage ? "run-stat-group-start" : ""}
                label={t("run.stats.spawned")}
                value={spawnedAgentCount(tasks)}
                max={limits.maxAgents}
                note={running > 0 ? t("run.spawn.running", { count: running }) : null}
              />
              <RunStat label={t("run.stats.spawnTokens")} value={spawnTokenTotal} max={limits.tokenBudget} />
            </>
          )}
        </div>
        {full && <div className="run-stats-warn">{t("run.teamLimits.reached")}</div>}
      </div>
    </div>
  );
}

/** Copies `text` to the clipboard; shows a check for a moment after. Doesn't toggle the card it sits in. */
function CopyButton({ text }) {
  const { t } = usePreferences();
  const [copied, setCopied] = useState(false);

  async function copy(e) {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Fallback for an insecure context (e.g. the app opened over LAN by IP).
      const el = document.createElement("textarea");
      el.value = text;
      el.setAttribute("readonly", "");
      el.style.position = "absolute";
      el.style.left = "-9999px";
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  const label = copied ? t("common.copied") : t("common.copy");
  return (
    <button type="button" className={`task-copy ${copied ? "is-copied" : ""}`} title={label} aria-label={label} onClick={copy}>
      {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
    </button>
  );
}

/** The run's prompt at the top of the page: three lines, with a toggle when it's longer than that. */
function RunPrompt({ text }) {
  const { t } = usePreferences();
  const ref = useRef(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !expanded) setOverflows(el.scrollHeight > el.clientHeight + 1);
  }, [text, expanded]);

  return (
    <div className="prompt-wrap">
      <div ref={ref} className={`prompt ${expanded ? "" : "prompt-clamped"}`} title={expanded ? undefined : text}>
        {text}
      </div>
      {(overflows || expanded) && (
        <button type="button" className="prompt-toggle" onClick={() => setExpanded((v) => !v)}>
          {expanded ? t("run.prompt.less") : t("run.prompt.more")}
        </button>
      )}
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
  const [runMenu, setRunMenu] = useState(null); // { run, x, y } while the right-click menu is open
  const [renamingId, setRenamingId] = useState(null); // run whose name is being edited in the list
  const closeRunMenu = React.useCallback(() => setRunMenu(null), []);
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
  }, []);

  useEffect(() => {
    if (view === "history" && runId) loadRun(runId);
  }, [runId, view]);

  // F2 renames the open run, as in a file explorer (not while typing somewhere else).
  useEffect(() => {
    if (view !== "history" || !selectedRunId) return undefined;
    function onKeyDown(e) {
      if (e.key !== "F2" || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.target.closest?.("input, textarea, select, [contenteditable='true']")) return;
      e.preventDefault();
      setRenamingId(selectedRunId);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [view, selectedRunId]);

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

  function applyRunTitle(id, title) {
    setRuns((list) => list.map((r) => (r.id === id ? { ...r, title } : r)));
    setSelectedRun((prev) => (prev?.id === id ? { ...prev, title } : prev));
  }

  /** Saves the name typed in the list; empty clears it so the prompt shows again. */
  async function commitRename(run, value) {
    setRenamingId(null);
    const title = value.trim() || null;
    if (title === (run.title || null) || (!run.title && title === run.prompt.trim())) return;
    applyRunTitle(run.id, title);
    try {
      await api.renameRun(run.id, title || "");
    } catch (err) {
      applyRunTitle(run.id, run.title || null);
      setRunActionError(err.message);
    }
  }

  function runDeleteBlockedTooltip(run) {
    if (run.status === "running") return t("run.deleteBlockedTooltip");
    if (run.review?.status === "pending") return t("run.review.deleteBlocked");
    return null;
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
      if (evt.type === "run-renamed") {
        applyRunTitle(evt.runId, evt.title || null);
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
                ? {
                    ...task,
                    status: evt.status,
                    ...(evt.usage ? { usage: evt.usage } : {}),
                    ...(evt.startedAt ? { startedAt: evt.startedAt } : {}),
                    ...(evt.endedAt ? { endedAt: evt.endedAt } : {}),
                  }
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

  // The task that received the run prompt: the agent of a single run, or a workflow's first step.
  const firstLeadTaskId = selectedRun?.tasks?.find((tk) => ["agent", "workflow-node", "workflow-router"].includes(tk.kind))?.id;

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
              onClick={() => renamingId !== r.id && navigate(`/run/${r.id}`)}
              onContextMenu={(e) => {
                e.preventDefault();
                setRunMenu({ run: r, x: e.clientX, y: e.clientY });
              }}
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
              {renamingId === r.id ? (
                <input
                  className="run-item-rename"
                  autoFocus
                  defaultValue={r.title || r.prompt}
                  placeholder={t("run.rename.placeholder")}
                  maxLength={120}
                  aria-label={t("run.rename")}
                  onFocus={(e) => e.target.select()}
                  onClick={(e) => e.stopPropagation()}
                  onBlur={(e) => commitRename(r, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      e.currentTarget.blur();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      // Drop the edit, then blur: commitRename sees the original value and does nothing.
                      e.currentTarget.value = r.title || r.prompt;
                      e.currentTarget.blur();
                    }
                  }}
                />
              ) : (
                <div className={`run-item-prompt ${r.title ? "has-title" : ""}`.trim()} title={r.prompt}>
                  {r.trigger?.type === "schedule" && <span title={t("run.trigger.schedule", { cron: r.trigger.cron })}>⏰ </span>}
                  {r.title || r.prompt.slice(0, 60)}
                </div>
              )}
            </div>
          ))}
        </div>
      </aside>}

      {runMenu && (
        <ContextMenu
          x={runMenu.x}
          y={runMenu.y}
          onClose={closeRunMenu}
          items={[
            {
              label: t("run.rename"),
              icon: <IconEdit size={14} />,
              title: "F2",
              onSelect: () => setRenamingId(runMenu.run.id),
            },
            {
              label: t("run.menu.delete"),
              icon: <IconTrash size={14} />,
              danger: true,
              disabled: !!runDeleteBlockedTooltip(runMenu.run),
              title: runDeleteBlockedTooltip(runMenu.run) || undefined,
              onSelect: () => setDeleteTarget(runMenu.run),
            },
          ]}
        />
      )}

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
            {/* Pinned to the top of the scroll area: which run this is, its status, and its limits. */}
            <div className="run-pinned">
              <div className="run-header">
                {selectedRun.title && <h2 className="run-title">{selectedRun.title}</h2>}
                <RunPrompt key={selectedRun.id} text={selectedRun.prompt} />
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
              <RunStats usage={selectedRun.teamLimits} tasks={selectedRun.tasks} />
            </div>
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
                {selectedRun.tasks.map((task) => (
                  // The run prompt is the first message of the chat: shown on the first lead task.
                  <TaskCard
                    key={task.id}
                    task={task}
                    parentTitle={
                      task.spawnedByTaskId
                        ? selectedRun.tasks.find((p) => p.id === task.spawnedByTaskId)?.title?.slice(0, 60)
                        : undefined
                    }
                    firstMessage={task.id === firstLeadTaskId ? selectedRun.prompt : undefined}
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
                        spawnCount={spawnedAgentCount(selectedRun.tasks)}
                        blueprintStatusOf={(name) => blueprintStatus(selectedRun.tasks, name)}
                        flow={teamFlow(selectedRun.tasks)}
                        outcome={teamRunOutcome(selectedRun)}
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
