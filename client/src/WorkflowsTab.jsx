import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "./api.js";
import WorkflowCanvas from "./WorkflowCanvas.jsx";
import { Button, ConfirmModal, FormActions, TabPageHeader } from "./components/index.js";
import { usePreferences } from "./PreferencesContext.jsx";

function WorkflowCard({ workflow, agentName, agentProvider, onEdit, onDelete }) {
  const { t } = usePreferences();
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="entity-card">
      <div className="entity-card-title">{workflow.name}</div>
      <div className="entity-card-desc">{workflow.description}</div>
      <div className="entity-card-meta">{t("workflows.stepCount", { count: workflow.nodes.length })}</div>
      {expanded && (
        <WorkflowCanvas
          readOnly
          nodes={workflow.nodes.map((n) => ({
            id: n.id,
            title: agentName(n.agentId),
            subtitle: n.kind === "router" ? t("kind.router") : n.autoStart === false ? t("workflows.manualBadge") : "",
            kind: n.kind,
            provider: agentProvider(n.agentId),
            x: n.x,
            y: n.y,
          }))}
          edges={workflow.edges}
          callEdges={workflow.nodes.flatMap((n) => (n.calleeNodeIds || []).map((to) => ({ from: n.id, to })))}
        />
      )}
      <FormActions>
        <Button variant="secondary" onClick={() => setExpanded((e) => !e)}>
          {expanded ? t("workflows.hideDiagram") : t("workflows.showDiagram")}
        </Button>
        <Button variant="secondary" onClick={onEdit}>
          {t("common.edit")}
        </Button>
        <Button variant="secondary" color="danger" onClick={onDelete}>
          {t("common.delete")}
        </Button>
      </FormActions>
    </div>
  );
}

export default function WorkflowsTab() {
  const navigate = useNavigate();
  const { t } = usePreferences();
  const [workflows, setWorkflows] = useState([]);
  const [agents, setAgents] = useState([]);
  const [confirmTarget, setConfirmTarget] = useState(null);

  function refresh() {
    api.listWorkflows().then((d) => setWorkflows(d.workflows));
  }

  useEffect(() => {
    api.listAgents().then((d) => setAgents(d.agents));
    refresh();
  }, []);

  async function confirmDelete() {
    const workflow = confirmTarget;
    setConfirmTarget(null);
    if (!workflow) return;
    await api.deleteWorkflow(workflow.id);
    refresh();
  }

  const agentName = (aid) => agents.find((a) => a.id === aid)?.name || t("workflows.deletedAgent");
  const agentProvider = (aid) => agents.find((a) => a.id === aid)?.provider || "claude";

  return (
    <div className="tab-content">
      <TabPageHeader
        title={t("nav.workflows")}
        actionLabel={t("workflows.create")}
        onAction={() => navigate("/workflows/new")}
        actionDisabled={!agents.length}
      />
      {!agents.length && <div className="error-box">{t("workflows.noAgents")}</div>}

      <div className="card-grid">
        {workflows.map((w) => (
          <WorkflowCard
            key={w.id}
            workflow={w}
            agentName={agentName}
            agentProvider={agentProvider}
            onEdit={() => navigate(`/workflows/${w.id}`)}
            onDelete={() => setConfirmTarget(w)}
          />
        ))}
      </div>

      {confirmTarget && (
        <ConfirmModal
          title={t("common.delete")}
          message={t("workflows.confirmDelete", { name: confirmTarget.name })}
          onConfirm={confirmDelete}
          onClose={() => setConfirmTarget(null)}
        />
      )}
    </div>
  );
}
