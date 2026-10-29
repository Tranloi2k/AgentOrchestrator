import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../shared/api.js";
import { usePreferences } from "../../app/PreferencesContext.jsx";
import { Button, ConfirmModal, FormActions, InfoBanner, TabPageHeader } from "../../shared/components/index.js";

export default function PluginsTab() {
  const navigate = useNavigate();
  const { t } = usePreferences();
  const [plugins, setPlugins] = useState([]);
  const [agents, setAgents] = useState([]);
  const [confirmTarget, setConfirmTarget] = useState(null);

  function refresh() {
    api.listPlugins().then((d) => setPlugins(d.plugins));
  }

  useEffect(() => {
    refresh();
    api.listAgents().then((d) => setAgents(d.agents));
  }, []);

  async function confirmDelete() {
    const plugin = confirmTarget;
    setConfirmTarget(null);
    if (!plugin) return;
    await api.deletePlugin(plugin.id);
    refresh();
    api.listAgents().then((d) => setAgents(d.agents));
  }

  const usedByCount = (pluginId) => agents.filter((a) => a.pluginIds?.includes(pluginId)).length;

  return (
    <div className="tab-content">
      <TabPageHeader title={t("plugins.title")} actionLabel={t("plugins.create")} onAction={() => navigate("/plugins/new")} />
      <InfoBanner>{t("plugins.banner")}</InfoBanner>

      <div className="card-grid">
        {plugins.map((p) => (
          <div key={p.id} className="entity-card">
            <div className="entity-card-title">{p.name}</div>
            <div className="entity-card-desc">{p.description}</div>
            <div className="entity-card-meta">
              {t("plugins.meta.source")}: {p.sourceType} — {p.sourceValue}
            </div>
            <div className="entity-card-meta">{t("plugins.meta.usedBy", { count: usedByCount(p.id) })}</div>
            <FormActions>
              <Button variant="secondary" onClick={() => navigate(`/plugins/${p.id}`)}>
                {t("common.edit")}
              </Button>
              <Button variant="secondary" color="danger" onClick={() => setConfirmTarget(p)}>
                {t("common.delete")}
              </Button>
            </FormActions>
          </div>
        ))}
        {!plugins.length && <div className="flow-desc">{t("plugins.empty")}</div>}
      </div>

      {confirmTarget && (
        <ConfirmModal
          title={t("common.delete")}
          message={t("plugins.confirmDelete", { name: confirmTarget.name })}
          onConfirm={confirmDelete}
          onClose={() => setConfirmTarget(null)}
        />
      )}
    </div>
  );
}
