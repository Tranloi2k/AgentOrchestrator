import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../shared/api.js";
import { IconEdit, IconTrash } from "../../shared/Icons.jsx";
import { usePreferences } from "../../app/PreferencesContext.jsx";
import { Button, ConfirmModal, TabPageHeader } from "../../shared/components/index.js";

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
      <TabPageHeader hint={t("plugins.banner")} actionLabel={t("plugins.create")} onAction={() => navigate("/plugins/new")} />

      <div className="entity-table-wrap">
        {plugins.length ? (
          <table className="entity-table">
            <colgroup>
              <col style={{ width: "20%" }} />
              <col />
              <col style={{ width: "24%" }} />
              <col style={{ width: 180 }} />
              <col style={{ width: 96 }} />
            </colgroup>
            <thead>
              <tr>
                <th>{t("list.col.name")}</th>
                <th>{t("list.col.description")}</th>
                <th>{t("list.col.source")}</th>
                <th>{t("list.col.usedBy")}</th>
                <th aria-label={t("list.col.actions")} />
              </tr>
            </thead>
            <tbody>
              {plugins.map((p) => {
                const source = `${p.sourceType} — ${p.sourceValue}`;
                const usedByLabel = t("plugins.meta.usedBy", { count: usedByCount(p.id) });
                return (
                  <tr key={p.id}>
                    <td title={p.name}>
                      <div className="entity-table-name" onClick={() => navigate(`/plugins/${p.id}`)}>
                        <span className="entity-table-name-text">{p.name}</span>
                      </div>
                    </td>
                    <td className="entity-table-desc" title={p.description}>{p.description}</td>
                    <td className="entity-table-meta" title={source}>{source}</td>
                    <td className="entity-table-meta" title={usedByLabel}>{usedByLabel}</td>
                    <td>
                      <div className="entity-table-actions">
                        <Button variant="icon" title={t("common.edit")} aria-label={t("common.edit")} onClick={() => navigate(`/plugins/${p.id}`)}>
                          <IconEdit />
                        </Button>
                        <Button variant="icon" color="danger" title={t("common.delete")} aria-label={t("common.delete")} onClick={() => setConfirmTarget(p)}>
                          <IconTrash />
                        </Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="flow-desc entity-table-empty">{t("plugins.empty")}</div>
        )}
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
