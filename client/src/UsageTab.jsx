import React, { useEffect, useState } from "react";
import { api } from "./api.js";
import { ProviderIcon } from "./Icons.jsx";
import { usePreferences } from "./PreferencesContext.jsx";
import { TabPageHeader, Button } from "./components/index.js";

function fmtInt(n) {
  return new Intl.NumberFormat("en-US").format(Math.round(n || 0));
}

function fmtCost(n) {
  return `$${(n || 0).toFixed(2)}`;
}

function fmtDuration(ms) {
  const s = (ms || 0) / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = s / 60;
  if (m < 60) return `${m.toFixed(1)}m`;
  return `${(m / 60).toFixed(1)}h`;
}

/** Total tokens counted as input+output — cache read/creation tokens are shown separately
 * since they're billed (and matter) very differently from a fresh input token. */
function totalTokens(p) {
  return (p?.inputTokens || 0) + (p?.outputTokens || 0);
}

function fmtDateTime(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleString();
}

const RATE_LIMIT_LABEL = { five_hour: "5h", seven_day: "7d", weekly: "7d" };

export default function UsageTab() {
  const { t } = usePreferences();
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);

  function refresh() {
    setLoading(true);
    api
      .getUsage()
      .then(setUsage)
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    refresh();
  }, []);

  if (loading && !usage) {
    return (
      <div className="tab-content">
        <TabPageHeader title={t("nav.usage")} />
        <p className="flow-desc">{t("detail.loading")}</p>
      </div>
    );
  }

  const claude = usage?.byProvider?.claude || {};
  const codex = usage?.byProvider?.codex || {};
  const gemini = usage?.byProvider?.gemini || {};
  const maxTokens = Math.max(totalTokens(claude), totalTokens(codex), totalTokens(gemini), 1);
  const providers = [
    { key: "claude", label: t("agents.provider.claude"), data: claude },
    { key: "codex", label: t("agents.provider.codex"), data: codex },
    { key: "gemini", label: t("agents.provider.gemini"), data: gemini },
  ];
  const claudeQuota = usage?.quota?.claude || null;
  const claudeRemainingPct = claudeQuota ? Math.max(0, Math.round((1 - (claudeQuota.utilization || 0)) * 100)) : null;

  return (
    <div className="tab-content">
      <TabPageHeader title={t("nav.usage")}>
        <Button variant="secondary" onClick={refresh}>
          {t("common.refresh")}
        </Button>
      </TabPageHeader>

      <h3 className="usage-section-title" style={{ marginTop: 0 }}>
        {t("usage.remainingQuota")}
      </h3>
      <div className="card-grid">
        <div className="entity-card">
          <div className="entity-card-title">
            <ProviderIcon provider="claude" title={t("agents.provider.claude")} />
            <span className="entity-card-title-text">{t("agents.provider.claude")}</span>
          </div>
          {claudeQuota ? (
            <>
              <div className="usage-bar-track">
                <div className="usage-bar-fill usage-bar-claude" style={{ width: `${claudeRemainingPct}%` }} />
              </div>
              <div className="entity-card-meta">
                {t("usage.remaining")}: {claudeRemainingPct}% ({RATE_LIMIT_LABEL[claudeQuota.rateLimitType] || claudeQuota.rateLimitType})
              </div>
              <div className="entity-card-meta">
                {t("usage.resetsAt")}: {fmtDateTime((claudeQuota.resetsAt || 0) * 1000)}
              </div>
              {claudeQuota.isUsingOverage && <div className="entity-card-meta">⚠️ {t("usage.overage")}</div>}
              <div className="entity-card-meta">
                {t("usage.asOf")}: {fmtDateTime(claudeQuota.updatedAt)}
              </div>
            </>
          ) : (
            <div className="entity-card-desc">{t("usage.quotaUnknown")}</div>
          )}
        </div>
        <div className="entity-card">
          <div className="entity-card-title">
            <ProviderIcon provider="codex" title={t("agents.provider.codex")} />
            <span className="entity-card-title-text">{t("agents.provider.codex")}</span>
          </div>
          <div className="entity-card-desc">{t("usage.quotaCodexUnavailable")}</div>
        </div>
        <div className="entity-card">
          <div className="entity-card-title">
            <ProviderIcon provider="gemini" title={t("agents.provider.gemini")} />
            <span className="entity-card-title-text">{t("agents.provider.gemini")}</span>
          </div>
          <div className="entity-card-desc">{t("usage.quotaGeminiUnavailable")}</div>
        </div>
      </div>

      <h3 className="usage-section-title">{t("usage.totals")}</h3>
      <div className="card-grid">
        {providers.map(({ key, label, data }) => (
          <div key={key} className="entity-card">
            <div className="entity-card-title">
              <ProviderIcon provider={key} title={label} />
              <span className="entity-card-title-text">{label}</span>
            </div>
            <div className="usage-bar-track">
              <div
                className={`usage-bar-fill usage-bar-${key}`}
                style={{ width: `${(totalTokens(data) / maxTokens) * 100}%` }}
              />
            </div>
            <div className="entity-card-meta">{t("usage.tasks")}: {fmtInt(data.tasks)}</div>
            <div className="entity-card-meta">{t("usage.inputTokens")}: {fmtInt(data.inputTokens)}</div>
            <div className="entity-card-meta">{t("usage.outputTokens")}: {fmtInt(data.outputTokens)}</div>
            <div className="entity-card-meta">
              {t("usage.cacheTokens")}: {fmtInt((data.cacheReadTokens || 0) + (data.cacheCreationTokens || 0))}
            </div>
            <div className="entity-card-meta">
              {t("usage.cost")}: {data.hasCost ? fmtCost(data.costUsd) : t("usage.costUnavailable")}
            </div>
            <div className="entity-card-meta">{t("usage.duration")}: {fmtDuration(data.durationMs)}</div>
          </div>
        ))}
      </div>

      {!!usage?.byAgent?.length && (
        <div className="usage-agent-table-wrap">
          <h3 className="usage-section-title">{t("usage.byAgent")}</h3>
          <table className="usage-agent-table">
            <thead>
              <tr>
                <th>{t("usage.agent")}</th>
                <th>{t("usage.provider")}</th>
                <th>{t("usage.tasks")}</th>
                <th>{t("usage.inputTokens")}</th>
                <th>{t("usage.outputTokens")}</th>
                <th>{t("usage.cost")}</th>
                <th>{t("usage.duration")}</th>
              </tr>
            </thead>
            <tbody>
              {usage.byAgent.map((a) => (
                <tr key={`${a.provider}-${a.agentId || a.agentName}`}>
                  <td>{a.agentName}</td>
                  <td>
                    <ProviderIcon provider={a.provider} size={14} />
                  </td>
                  <td>{fmtInt(a.tasks)}</td>
                  <td>{fmtInt(a.inputTokens)}</td>
                  <td>{fmtInt(a.outputTokens)}</td>
                  <td>{a.hasCost ? fmtCost(a.costUsd) : "—"}</td>
                  <td>{fmtDuration(a.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!usage?.byAgent?.length && (
        <p className="entity-card-desc">{t("usage.empty")}</p>
      )}
    </div>
  );
}
