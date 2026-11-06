import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../shared/api.js";
import { IconEdit, IconTrash } from "../../shared/Icons.jsx";
import { usePreferences } from "../../app/PreferencesContext.jsx";
import { Badge, Button, ConfirmModal, ErrorBox, TabPageHeader } from "../../shared/components/index.js";

export default function ProvidersTab() {
  const navigate = useNavigate();
  const { t } = usePreferences();
  const [providers, setProviders] = useState([]);
  const [agents, setAgents] = useState([]);
  const [cliMissing, setCliMissing] = useState(false);
  const [confirmTarget, setConfirmTarget] = useState(null);
  const [error, setError] = useState("");

  function refresh() {
    api.listProviders().then((d) => setProviders(d.providers));
  }

  useEffect(() => {
    refresh();
    api.listAgents().then((d) => setAgents(d.agents));
    api.meta().then((d) => setCliMissing(d.providerAvailability?.opencode === false));
  }, []);

  async function confirmDelete() {
    const provider = confirmTarget;
    setConfirmTarget(null);
    if (!provider) return;
    setError("");
    try {
      await api.deleteProvider(provider.id);
    } catch (err) {
      setError(err.message);
    }
    refresh();
  }

  // An OpenCode agent without a connection of its own runs on the default one.
  const usedByCount = (p) =>
    agents.filter((a) => a.provider === "opencode" && (a.connectionId === p.id || (!a.connectionId && p.isDefault))).length;

  return (
    <div className="tab-content">
      <TabPageHeader hint={t("providers.banner")} actionLabel={t("providers.create")} onAction={() => navigate("/providers/new")} />
      {cliMissing && <ErrorBox>{t("providers.cliMissing")}</ErrorBox>}
      <ErrorBox>{error}</ErrorBox>

      <div className="entity-table-wrap">
        {providers.length ? (
          <table className="entity-table">
            <colgroup>
              <col style={{ width: "28%" }} />
              <col style={{ width: 120 }} />
              <col />
              <col style={{ width: 180 }} />
              <col style={{ width: 96 }} />
            </colgroup>
            <thead>
              <tr>
                <th>{t("list.col.name")}</th>
                <th>{t("providers.col.tier")}</th>
                <th>{t("providers.col.key")}</th>
                <th>{t("list.col.usedBy")}</th>
                <th aria-label={t("list.col.actions")} />
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => {
                const usedByLabel = t("providers.meta.usedBy", { count: usedByCount(p) });
                return (
                  <tr key={p.id}>
                    <td title={p.name}>
                      <div className="entity-table-name" onClick={() => navigate(`/providers/${p.id}`)}>
                        <span className="entity-table-name-text">{p.name}</span>
                        {p.isDefault && (
                          <Badge variant="done" uppercase={false} style={{ marginLeft: 8 }}>
                            {t("providers.default")}
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td>
                      <Badge variant={p.tier === "free" ? "skipped" : "running"} uppercase={false}>
                        {t(`providers.tier.${p.tier}`)}
                      </Badge>
                    </td>
                    <td className="entity-table-meta">
                      <code>{p.maskedKey}</code>
                    </td>
                    <td className="entity-table-meta" title={usedByLabel}>{usedByLabel}</td>
                    <td>
                      <div className="entity-table-actions">
                        <Button variant="icon" title={t("common.edit")} aria-label={t("common.edit")} onClick={() => navigate(`/providers/${p.id}`)}>
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
          <div className="flow-desc entity-table-empty">{t("providers.empty")}</div>
        )}
      </div>

      {confirmTarget && (
        <ConfirmModal
          title={t("common.delete")}
          message={t("providers.confirmDelete", { name: confirmTarget.name })}
          onConfirm={confirmDelete}
          onClose={() => setConfirmTarget(null)}
        />
      )}
    </div>
  );
}
