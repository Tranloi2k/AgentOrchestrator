import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../shared/api.js";
import WorkflowCanvas from "./WorkflowCanvas.jsx";
import TeamDiagram, { teamFromNodes } from "./team/TeamDiagram.jsx";
import { Button, ConfirmModal, FormActions, TabPageHeader } from "../../shared/components/index.js";
import { nodeDisplay, callEdgesOf } from "./workflowDisplay.js";
import { usePreferences } from "../../app/PreferencesContext.jsx";

function WorkflowCard({ workflow, agents, onEdit, onDelete }) {
  const { t } = usePreferences();
  const [expanded, setExpanded] = useState(false);
  const type = workflow.type || "pipeline";

  return (
    <div className="entity-card">
      <div className="entity-card-title">
        <span className="entity-card-title-text">{workflow.name}</span>
      </div>
      <div className="entity-card-tags">
        <span className="card-tag">{t(`workflows.type.${type}`)}</span>
      </div>
      <div className="entity-card-desc">{workflow.description}</div>
      <div className="entity-card-meta">
        {type === "team"
          ? t("workflows.memberCount", { count: workflow.team?.members?.length || 0 })
          : t("workflows.stepCount", { count: workflow.nodes.length })}
      </div>
      {expanded && type === "team" && <TeamDiagram {...teamFromNodes(workflow.nodes)} agents={agents} compact />}
      {expanded && type !== "team" && (
        <WorkflowCanvas
          readOnly
          nodes={workflow.nodes.map((n) => ({ id: n.id, ...nodeDisplay(n, agents, t), kind: n.kind, x: n.x, y: n.y }))}
          edges={workflow.edges}
          callEdges={callEdgesOf(workflow.nodes)}
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
            agents={agents}
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
