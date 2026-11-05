import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../shared/api.js";
import { IconCopy, IconEdit, IconTrash, ProviderIcon } from "../../shared/Icons.jsx";
import { usePreferences } from "../../app/PreferencesContext.jsx";
import { Button, ConfirmModal, TabPageHeader } from "../../shared/components/index.js";

export default function AgentsTab() {
  const navigate = useNavigate();
  const { t } = usePreferences();
  const [agents, setAgents] = useState([]);
  const [skills, setSkills] = useState([]);
  const [plugins, setPlugins] = useState([]);
  const [workflows, setWorkflows] = useState([]);
  const [confirmTarget, setConfirmTarget] = useState(null);
  const [duplicateTarget, setDuplicateTarget] = useState(null);
  // What the server said when it refused a delete the list above didn't predict.
  const [deleteError, setDeleteError] = useState("");
  const [providerAvailability, setProviderAvailability] = useState({ claude: true, codex: true, gemini: true });

  function refresh() {
    api.listAgents().then((d) => setAgents(d.agents));
  }

  useEffect(() => {
    api.listSkills().then((d) => setSkills(d.skills));
    api.listPlugins().then((d) => setPlugins(d.plugins));
    api.listWorkflows().then((d) => setWorkflows(d.workflows));
    api.meta().then((d) => d.providerAvailability && setProviderAvailability(d.providerAvailability));
    refresh();
  }, []);

  // Same rule as the server (workflowAgentIds): a team member's backups and a Pipeline step's
  // fallbacks are in use too, not only each node's main agent.
  function usedByWorkflows(agentId) {
    const uses = (w) =>
      (w.nodes || []).some((n) => n.agentId === agentId || n.agentIds?.includes(agentId) || n.fallbackAgentIds?.includes(agentId)) ||
      w.team?.coordinator?.agentId === agentId ||
      (w.team?.members || []).some((m) => m.agentId === agentId || m.agentIds?.includes(agentId));
    return workflows.filter(uses).map((w) => w.name);
  }

  // The workflow list is re-read each time, so a workflow edited in another tab is counted.
  function askDelete(agent) {
    api.listWorkflows().then((d) => setWorkflows(d.workflows));
    setConfirmTarget(agent);
  }

  async function confirmDelete() {
    const agent = confirmTarget;
    setConfirmTarget(null);
    if (!agent) return;
    try {
      await api.deleteAgent(agent.id);
    } catch (err) {
      setDeleteError(t("agents.deleteFailed", { name: agent.name, error: err.message }));
    }
    refresh();
  }

  async function confirmDuplicate() {
    const agent = duplicateTarget;
    setDuplicateTarget(null);
    if (!agent) return;
    await api.duplicateAgent(agent.id);
    refresh();
  }

  const blockedNames = confirmTarget ? usedByWorkflows(confirmTarget.id) : [];
  const isBlocked = blockedNames.length > 0;

  return (
    <div className="tab-content">
      <TabPageHeader title={t("nav.agents")} actionLabel={t("agents.create")} onAction={() => navigate("/agents/new")} />

      <div className="entity-table-wrap">
        <table className="entity-table">
          <colgroup>
            <col style={{ width: "18%" }} />
            <col style={{ width: 150 }} />
            <col />
            <col style={{ width: 130 }} />
            <col style={{ width: "14%" }} />
            <col style={{ width: "16%" }} />
            <col style={{ width: 132 }} />
          </colgroup>
          <thead>
            <tr>
              <th>{t("list.col.name")}</th>
              <th>{t("list.col.tags")}</th>
              <th>{t("list.col.description")}</th>
              <th>{t("list.col.model")}</th>
              <th>{t("list.col.tools")}</th>
              <th>{t("list.col.skillsPlugins")}</th>
              <th aria-label={t("list.col.actions")} />
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => {
              const model = a.model || t("common.default");
              const tools = (a.provider || "claude") === "claude" ? (a.allowedTools || []).join(", ") || "-" : "-";
              const extras = [
                a.skillIds?.length &&
                  `${t("agents.meta.skills")}: ${a.skillIds.map((sid) => skills.find((s) => s.id === sid)?.name || "?").join(", ")}`,
                a.pluginIds?.length &&
                  `${t("agents.meta.plugins")}: ${a.pluginIds.map((pid) => plugins.find((p) => p.id === pid)?.name || "?").join(", ")}`,
              ]
                .filter(Boolean)
                .join(" · ") || "-";
              return (
                <tr key={a.id}>
                  <td title={a.name}>
                    <div className="entity-table-name" onClick={() => navigate(`/agents/${a.id}`)}>
                      <ProviderIcon
                        provider={a.provider || "claude"}
                        title={t(`agents.provider.${a.provider || "claude"}`)}
                      />
                      <span className="entity-table-name-text">{a.name}</span>
                    </div>
                  </td>
                  <td>
                    <div className="entity-table-tags">
                      <span className={`card-tag card-tag-access-${a.accessLevel || "write"}`}>{t(`agents.access.${a.accessLevel || "write"}`)}</span>
                      {!providerAvailability[a.provider || "claude"] && (
                        <span
                          className="card-tag card-tag-error"
                          title={t("agents.provider.unavailableWarning", { name: t(`agents.provider.${a.provider || "claude"}`) })}
                        >
                          {t("agents.provider.notInstalled")}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="entity-table-desc" title={a.description}>{a.description}</td>
                  <td className="entity-table-meta" title={model}>{model}</td>
                  <td className="entity-table-meta" title={tools}>{tools}</td>
                  <td className="entity-table-meta" title={extras}>{extras}</td>
                  <td>
                    <div className="entity-table-actions">
                      <Button variant="icon" title={t("common.edit")} aria-label={t("common.edit")} onClick={() => navigate(`/agents/${a.id}`)}>
                        <IconEdit />
                      </Button>
                      <Button variant="icon" title={t("common.duplicate")} aria-label={t("common.duplicate")} onClick={() => setDuplicateTarget(a)}>
                        <IconCopy />
                      </Button>
                      <Button variant="icon" color="danger" title={t("common.delete")} aria-label={t("common.delete")} onClick={() => askDelete(a)}>
                        <IconTrash />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {confirmTarget && (
        <ConfirmModal
          title={t("common.delete")}
          message={t("agents.confirmDelete", { name: confirmTarget.name })}
          blocked={isBlocked}
          reason={isBlocked ? t("agents.deleteBlocked", { name: confirmTarget.name, names: blockedNames.join(", ") }) : ""}
          onConfirm={confirmDelete}
          onClose={() => setConfirmTarget(null)}
        />
      )}

      {deleteError && (
        <ConfirmModal
          title={t("common.delete")}
          blocked
          reason={deleteError}
          onConfirm={() => setDeleteError("")}
          onClose={() => setDeleteError("")}
        />
      )}

      {duplicateTarget && (
        <ConfirmModal
          title={t("common.duplicate")}
          message={t("agents.confirmDuplicate", { name: duplicateTarget.name })}
          confirmLabel={t("common.duplicate")}
          danger={false}
          onConfirm={confirmDuplicate}
          onClose={() => setDuplicateTarget(null)}
        />
      )}
    </div>
  );
}
