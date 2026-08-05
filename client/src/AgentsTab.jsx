import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "./api.js";
import { ProviderIcon } from "./Icons.jsx";
import { usePreferences } from "./PreferencesContext.jsx";
import { Badge, Button, ConfirmModal, FormActions, TabPageHeader } from "./components/index.js";

export default function AgentsTab() {
  const navigate = useNavigate();
  const { t } = usePreferences();
  const [agents, setAgents] = useState([]);
  const [skills, setSkills] = useState([]);
  const [plugins, setPlugins] = useState([]);
  const [workflows, setWorkflows] = useState([]);
  const [confirmTarget, setConfirmTarget] = useState(null);
  const [duplicateTarget, setDuplicateTarget] = useState(null);
  const [providerAvailability, setProviderAvailability] = useState({ claude: true, codex: true });

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

  function usedByWorkflows(agentId) {
    return workflows.filter((w) => w.nodes?.some((n) => n.agentId === agentId)).map((w) => w.name);
  }

  async function confirmDelete() {
    const agent = confirmTarget;
    setConfirmTarget(null);
    if (!agent) return;
    await api.deleteAgent(agent.id);
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

      <div className="card-grid">
        {agents.map((a) => (
          <div key={a.id} className="entity-card">
            <div className="entity-card-title">
              <ProviderIcon
                provider={a.provider || "claude"}
                title={t(a.provider === "codex" ? "agents.provider.codex" : "agents.provider.claude")}
              />
              <span className="entity-card-title-text">{a.name}</span>
              {a.readOnly && <Badge variant="pending">{t("common.readOnly")}</Badge>}
              {!providerAvailability[a.provider || "claude"] && (
                <Badge variant="error" title={t("agents.provider.unavailableWarning", { name: t(a.provider === "codex" ? "agents.provider.codex" : "agents.provider.claude") })}>
                  {t("agents.provider.notInstalled")}
                </Badge>
              )}
            </div>
            <div className="entity-card-desc">{a.description}</div>
            {a.provider === "codex" ? (
              <>
                <div className="entity-card-meta">
                  {t("agents.meta.model")}: {a.model || t("common.default")} · {t("agents.codexSandbox")}: {a.codexSandbox}
                </div>
              </>
            ) : (
              <>
                <div className="entity-card-meta">
                  {t("agents.meta.model")}: {a.model || t("common.default")} · {t("agents.meta.mode")}: {a.permissionMode}
                </div>
                <div className="entity-card-meta">
                  {t("agents.meta.allow")}: {(a.allowedTools || []).join(", ") || "-"}
                </div>
                <div className="entity-card-meta">
                  {t("agents.meta.deny")}: {(a.disallowedTools || []).join(", ") || "-"}
                </div>
              </>
            )}
            {!!a.skillIds?.length && (
              <div className="entity-card-meta">
                {t("agents.meta.skills")}: {a.skillIds.map((sid) => skills.find((s) => s.id === sid)?.name || "?").join(", ")}
              </div>
            )}
            {!!a.pluginIds?.length && (
              <div className="entity-card-meta">
                {t("agents.meta.plugins")}: {a.pluginIds.map((pid) => plugins.find((p) => p.id === pid)?.name || "?").join(", ")}
              </div>
            )}
            <FormActions>
              <Button variant="secondary" onClick={() => navigate(`/agents/${a.id}`)}>
                {t("common.edit")}
              </Button>
              <Button variant="secondary" onClick={() => setDuplicateTarget(a)}>
                {t("common.duplicate")}
              </Button>
              <Button variant="secondary" color="danger" onClick={() => setConfirmTarget(a)}>
                {t("common.delete")}
              </Button>
            </FormActions>
          </div>
        ))}
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
