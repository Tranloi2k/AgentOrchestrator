import React, { useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import WorkflowCanvas from "./WorkflowCanvas.jsx";
import DirBrowserModal from "./DirBrowserModal.jsx";
import { IconTrash } from "./Icons.jsx";
import { usePreferences } from "./PreferencesContext.jsx";
import { Badge, Button, CheckboxField, ConfirmModal, ErrorBox, HelperText, SegmentedControl } from "./components/index.js";

function useWebSocket(onEvent) {
  const wsRef = useRef(null);
  useEffect(() => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    wsRef.current = ws;
    ws.onmessage = (msg) => {
      try {
        onEvent(JSON.parse(msg.data));
      } catch {
        /* ignore */
      }
    };
    return () => ws.close();
  }, [onEvent]);
}

function TaskCard({ task }) {
  const { t } = usePreferences();
  const [open, setOpen] = useState(true);
  const kindKey =
    {
      planner: "kind.planner",
      "workflow-node": "kind.step",
      "workflow-router": "kind.router",
      "agent-call": "kind.agentCall",
    }[task.kind] || "kind.agent";

  return (
    <div className="task-card">
      <div className="task-head" onClick={() => setOpen((o) => !o)}>
        <span className="task-title">
          <Badge variant="pending" uppercase={false} style={{ fontSize: 10, marginRight: 6 }}>
            {t(kindKey)}
          </Badge>
          {task.title}
        </span>
        <Badge variant={task.status}>{t(`status.${task.status}`)}</Badge>
      </div>
      {open && <pre>{task.log?.length ? task.log.join("\n") : t("run.noLog")}</pre>}
    </div>
  );
}

export default function RunTab() {
  const { t } = usePreferences();
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null); // run object pending delete, or "__all__"

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

  function refreshRuns() {
    api.listRuns().then((d) => setRuns(d.runs));
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

      setSelectedRun((prev) => {
        if (!prev) return prev;
        const next = { ...prev, tasks: prev.tasks.map((task) => ({ ...task, log: [...task.log] })) };

        if (evt.type === "task-created") {
          next.tasks = [...next.tasks, { ...evt.task, log: [] }];
        } else if (evt.type === "task-status") {
          next.tasks = next.tasks.map((task) => (task.id === evt.taskId ? { ...task, status: evt.status } : task));
        } else if (evt.type === "log") {
          next.tasks = next.tasks.map((task) =>
            task.id === evt.taskId ? { ...task, log: [...task.log, evt.line] } : task
          );
        } else if (evt.type === "run-status") {
          next.status = evt.status;
          refreshRuns();
        }
        return next;
      });
    },
    [selectedRunId]
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
      refreshRuns();
      loadRun(data.runId);
    } catch (err) {
      setError(err.message);
    } finally {
      setSubmitting(false);
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

  const deleteBlocked = deleteTarget && deleteTarget !== "__all__" && deleteTarget.status === "running";

  const currentAgent = agents.find((a) => a.id === agentId);
  const currentWorkflow = workflows.find((w) => w.id === workflowId);

  return (
    <div className="app">
      <div className="sidebar">
        <p className="sidebar-section-title">{t("run.config")}</p>
        <form className="run-form" onSubmit={handleSubmit}>
          <SegmentedControl
            options={[
              { value: "workflow", label: t("run.mode.workflow") },
              { value: "agent", label: t("run.mode.agent") },
            ]}
            value={mode}
            onChange={setMode}
          />

          <label>{t("run.prompt")}</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={t("run.prompt.placeholder")}
          />

          {mode === "agent" ? (
            <>
              <label>{t("run.agent")}</label>
              <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                    {a.readOnly ? ` (${t("common.readOnly")})` : ""}
                  </option>
                ))}
              </select>
              {currentAgent && <HelperText>{currentAgent.description}</HelperText>}

              <CheckboxField
                id="decompose"
                checked={decompose}
                onChange={setDecompose}
                label={t("run.decompose")}
              />
            </>
          ) : (
            <>
              <label>{t("run.workflow")}</label>
              <select value={workflowId} onChange={(e) => setWorkflowId(e.target.value)}>
                {workflows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
              {currentWorkflow && <HelperText>{currentWorkflow.description}</HelperText>}
              {!workflows.length && <HelperText>{t("run.noWorkflow")}</HelperText>}
            </>
          )}

          <label>{t("run.cwd")}</label>
          <div className="cwd-row">
            <input type="text" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder={defaultCwd} />
            <Button variant="secondary" type="button" onClick={() => setBrowsing(true)}>
              {t("run.browse")}
            </Button>
          </div>

          <ErrorBox>{error}</ErrorBox>

          <Button
            variant="primary"
            type="submit"
            disabled={submitting || !prompt.trim() || (mode === "workflow" && !workflowId)}
          >
            {submitting ? t("run.submitting") : t("common.run")}
          </Button>
        </form>

        <div className="run-list">
          <div className="run-list-header">
            <span>{t("run.history")}</span>
            {runs.length > 1 && (
              <Button variant="icon" title={t("run.clearAll")} onClick={() => setDeleteTarget("__all__")}>
                <IconTrash size={13} />
              </Button>
            )}
          </div>
          {runs.map((r) => (
            <div
              key={r.id}
              className={`run-item ${r.id === selectedRunId ? "active" : ""}`}
              onClick={() => loadRun(r.id)}
            >
              <div className="run-item-top">
                <Badge variant={r.status} className="status">
                  {t(`status.${r.status}`)}
                </Badge>
                <Button
                  variant="icon"
                  className="run-item-delete"
                  title={r.status === "running" ? t("run.deleteBlockedTooltip") : t("run.delete")}
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
      </div>

      {deleteTarget && (
        <ConfirmModal
          title={t("run.delete")}
          message={deleteTarget === "__all__" ? t("run.confirmClearAll") : t("run.confirmDelete")}
          blocked={deleteBlocked}
          reason={deleteBlocked ? t("run.deleteBlockedReason") : ""}
          onConfirm={confirmDeleteRun}
          onClose={() => setDeleteTarget(null)}
        />
      )}

      <div className="main">
        {!selectedRun && mode === "workflow" && currentWorkflow && (
          <div className="process-preview">
            <div className="process-preview-title">{t("run.preview.title", { name: currentWorkflow.name })}</div>
            <WorkflowCanvas
              readOnly
              nodes={currentWorkflow.nodes.map((n) => ({
                id: n.id,
                title: agents.find((a) => a.id === n.agentId)?.name || "?",
                subtitle: n.kind === "router" ? t("kind.router") : "",
                kind: n.kind,
                provider: agents.find((a) => a.id === n.agentId)?.provider || "claude",
                x: n.x,
                y: n.y,
              }))}
              edges={currentWorkflow.edges}
              callEdges={currentWorkflow.nodes.flatMap((n) => (n.calleeNodeIds || []).map((to) => ({ from: n.id, to })))}
            />
            <div className="empty-state-sub">{t("run.preview.hint")}</div>
          </div>
        )}
        {!selectedRun && !(mode === "workflow" && currentWorkflow) && (
          <div className="empty-state">
            <div className="empty-state-icon">▶</div>
            {t("run.empty")}
          </div>
        )}
        {selectedRun && (
          <>
            <div className="run-header">
              <div className="prompt">{selectedRun.prompt}</div>
              <div className="meta">
                {selectedRun.workflowId
                  ? t("run.meta.workflow")
                  : t("run.meta.agent", { id: selectedRun.agentId })}{" "}
                · {selectedRun.decompose ? t("run.meta.multi") : t("run.meta.single")} ·{" "}
                <Badge variant={selectedRun.status}>{t(`status.${selectedRun.status}`)}</Badge>
              </div>
            </div>
            {selectedRun.workflowId && selectedRun.workflowNodes && (
              <WorkflowCanvas
                readOnly
                nodes={selectedRun.workflowNodes.map((n) => {
                  const task = selectedRun.tasks.find((tk) => tk.nodeId === n.id);
                  const agent = agents.find((a) => a.id === n.agentId);
                  return {
                    id: n.id,
                    title: agent?.name || n.agentId,
                    subtitle: task ? (task.status === "running" ? t("status.runningNow") : t(`status.${task.status}`)) : n.kind === "router" ? t("kind.router") : "",
                    status: task?.status,
                    kind: n.kind,
                    provider: agent?.provider || "claude",
                    x: n.x,
                    y: n.y,
                  };
                })}
                edges={selectedRun.workflowEdges.map((e) => ({
                  ...e,
                  status: selectedRun.tasks.find((tk) => tk.nodeId === e.to)?.status,
                }))}
                callEdges={selectedRun.workflowNodes.flatMap((n) =>
                  (n.calleeNodeIds || []).map((to) => ({
                    from: n.id,
                    to,
                    status: selectedRun.tasks.find((tk) => tk.nodeId === to && tk.kind === "agent-call")?.status,
                  }))
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
