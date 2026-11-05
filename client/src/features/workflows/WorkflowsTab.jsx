import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../shared/api.js";
import WorkflowCanvas from "./WorkflowCanvas.jsx";
import TeamDiagram, { teamFromNodes } from "./team/TeamDiagram.jsx";
import { Button, ConfirmModal, TabPageHeader } from "../../shared/components/index.js";
import { nodeDisplay, callEdgesOf } from "./workflowDisplay.js";
import { IconEdit, IconEye, IconEyeOff, IconTrash } from "../../shared/Icons.jsx";
import { usePreferences } from "../../app/PreferencesContext.jsx";

const COLUMN_COUNT = 5;

function WorkflowRow({ workflow, agents, onEdit, onDelete }) {
  const { t } = usePreferences();
  const [expanded, setExpanded] = useState(false);
  const type = workflow.type || "pipeline";
  const size =
    type === "team"
      ? t("workflows.memberCount", { count: workflow.team?.members?.length || 0 })
      : t("workflows.stepCount", { count: workflow.nodes.length });
  const toggleLabel = expanded ? t("workflows.hideDiagram") : t("workflows.showDiagram");

  return (
    <>
      <tr>
        <td title={workflow.name}>
          <div className="entity-table-name" onClick={onEdit}>
            <span className="entity-table-name-text">{workflow.name}</span>
          </div>
        </td>
        <td>
          <span className="card-tag">{t(`workflows.type.${type}`)}</span>
        </td>
        <td className="entity-table-desc" title={workflow.description}>{workflow.description}</td>
        <td className="entity-table-meta" title={size}>{size}</td>
        <td>
          <div className="entity-table-actions">
            <Button variant="icon" title={toggleLabel} aria-label={toggleLabel} aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
              {expanded ? <IconEyeOff /> : <IconEye />}
            </Button>
            <Button variant="icon" title={t("common.edit")} aria-label={t("common.edit")} onClick={onEdit}>
              <IconEdit />
            </Button>
            <Button variant="icon" color="danger" title={t("common.delete")} aria-label={t("common.delete")} onClick={onDelete}>
              <IconTrash />
            </Button>
          </div>
        </td>
      </tr>
      {expanded && (
        <tr className="entity-table-detail-row">
          <td colSpan={COLUMN_COUNT}>
            {type === "team" ? (
              <TeamDiagram {...teamFromNodes(workflow.nodes)} agents={agents} compact />
            ) : (
              <WorkflowCanvas
                readOnly
                nodes={workflow.nodes.map((n) => ({ id: n.id, ...nodeDisplay(n, agents, t), kind: n.kind, x: n.x, y: n.y }))}
                edges={workflow.edges}
                callEdges={callEdgesOf(workflow.nodes)}
              />
            )}
          </td>
        </tr>
      )}
    </>
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

      {!!workflows.length && (
        <div className="entity-table-wrap">
          <table className="entity-table">
            <colgroup>
              <col style={{ width: "22%" }} />
              <col style={{ width: 120 }} />
              <col />
              <col style={{ width: 150 }} />
              <col style={{ width: 132 }} />
            </colgroup>
            <thead>
              <tr>
                <th>{t("list.col.name")}</th>
                <th>{t("list.col.type")}</th>
                <th>{t("list.col.description")}</th>
                <th>{t("list.col.size")}</th>
                <th aria-label={t("list.col.actions")} />
              </tr>
            </thead>
            <tbody>
              {workflows.map((w) => (
                <WorkflowRow
                  key={w.id}
                  workflow={w}
                  agents={agents}
                  onEdit={() => navigate(`/workflows/${w.id}`)}
                  onDelete={() => setConfirmTarget(w)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

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
