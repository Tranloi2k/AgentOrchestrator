import React, { useState } from "react";
import { api } from "./api.js";
import { usePreferences } from "./PreferencesContext.jsx";
import { Button, ErrorBox, HelperText } from "./components/index.js";

/**
 * Who a follow-up goes to — mirrors chatLead() in server/executor.js: the agent of a single-agent
 * run, a Team's coordinator, or the Pipeline step that finished last.
 */
function leadName(run, agents, t) {
  const nameOf = (agentId) => agents.find((a) => a.id === agentId)?.name || t("workflows.deletedAgent");
  if (!run.workflowId) return nameOf(run.agentId);
  const nodes = run.workflowNodes || [];
  if (run.workflowType === "team") {
    const coord = nodes.find((n) => n.teamRole === "coordinator");
    return coord ? nameOf(coord.agentId) : null;
  }
  for (let i = run.tasks.length - 1; i >= 0; i--) {
    const task = run.tasks[i];
    if (task.status === "done" && task.nodeId && ["workflow-node", "workflow-router", "followup"].includes(task.kind)) {
      const node = nodes.find((n) => n.id === task.nodeId);
      if (node) return nameOf(node.agentId);
    }
  }
  return null;
}

/**
 * Chat box pinned beside a run: sends a follow-up to the run's lead agent in the same context,
 * stops whatever is running (the first run or a chat turn), and clears the chat. Clearing and
 * per-turn delete are confirmed by the Run tab.
 */
export default function RunChatBox({ run, agents, onSent, onStop, onClearChat }) {
  const { t } = usePreferences();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const running = run.status === "running";
  const lead = leadName(run, agents, t);
  if (!lead && !running) return null;
  const reviewPending = run.review?.status === "pending";
  const turns = run.tasks.filter((task) => task.kind === "followup").length;
  const locked = running || busy;

  async function send() {
    const text = message.trim();
    if (!text || locked) return;
    setBusy(true);
    setError("");
    try {
      await api.continueRun(run.id, text);
      setMessage("");
      onSent?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Pending changes don't block chatting: the next turn keeps editing them (one combined review).
  const hint = running ? t("run.chat.running") : reviewPending ? t("run.chat.continuesReview") : t("run.chat.hint");

  return (
    <div className="run-chat">
      <div className="run-chat-head">
        <span className="run-chat-title">{lead ? t("run.chat.to", { name: lead }) : t("run.chat.title")}</span>
        {turns > 0 && !running && (
          <button type="button" className="run-chat-clear" onClick={onClearChat} title={t("run.chat.clear")}>
            {t("run.chat.clearCount", { count: turns })}
          </button>
        )}
      </div>
      <textarea
        className="run-chat-input"
        value={message}
        disabled={locked}
        placeholder={locked ? hint : t("run.chat.placeholder")}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            send();
          }
        }}
      />
      <div className="run-chat-actions">
        <HelperText>{hint}</HelperText>
        {running ? (
          <Button variant="secondary" color="danger" disabled={run.stopping} onClick={onStop}>
            {run.stopping ? t("run.stopping") : t("run.chat.stop")}
          </Button>
        ) : (
          <Button variant="primary" disabled={!message.trim() || locked} onClick={send}>
            {busy ? "..." : t("run.chat.send")}
          </Button>
        )}
      </div>
      <ErrorBox>{error}</ErrorBox>
    </div>
  );
}
