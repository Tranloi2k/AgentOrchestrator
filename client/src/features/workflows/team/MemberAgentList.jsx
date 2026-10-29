import React, { useEffect, useState } from "react";
import { api } from "../../../shared/api.js";
import { IconClose, ProviderIcon } from "../../../shared/Icons.jsx";
import { usePreferences } from "../../../app/PreferencesContext.jsx";
import { Button, HelperText } from "../../../shared/components/index.js";

// Same cap as MAX_MEMBER_AGENTS in server/src/features/workflows/workflow-model.js.
const MAX_AGENTS = 6;

/**
 * A team member's agents, in the order the server tries them: the first one runs, and when it is
 * out of quota or its CLI is missing the server moves on to the next (see server team-calls.js).
 * Each row shows the agent's provider, and a warning when that CLI isn't installed here.
 */
export default function MemberAgentList({ agentIds, agents, onChange }) {
  const { t } = usePreferences();
  const [availability, setAvailability] = useState({});
  useEffect(() => {
    api.meta().then((m) => m?.providerAvailability && setAvailability(m.providerAvailability));
  }, []);

  const move = (from, to) => {
    const next = agentIds.slice();
    [next[from], next[to]] = [next[to], next[from]];
    onChange(next);
  };
  const addable = agents.filter((a) => !agentIds.includes(a.id));

  return (
    <>
      <div className="field-label">{t("workflows.team.memberAgents")}</div>
      {agentIds.map((id, i) => {
        const agent = agents.find((a) => a.id === id);
        const provider = agent?.provider || "claude";
        return (
          <div key={id} className="branch-row member-agent-row">
            <span className="branch-target">
              {i + 1}. {agent ? <ProviderIcon provider={provider} size={14} /> : null} {agent?.name || t("workflows.deletedAgent")}
              {agent && <span className="member-agent-provider"> · {t(`agents.provider.${provider}`)}</span>}
              {i === 0 && agentIds.length > 1 && <span className="member-agent-provider"> · {t("workflows.team.memberAgents.primary")}</span>}
            </span>
            {agent && availability[provider] === false && (
              <span className="card-tag card-tag-error" title={t("agents.provider.unavailableWarning", { name: t(`agents.provider.${provider}`) })}>
                {t("agents.provider.notInstalled")}
              </span>
            )}
            <Button variant="icon" title={t("workflows.team.memberAgents.up")} disabled={i === 0} onClick={() => move(i, i - 1)}>
              ↑
            </Button>
            <Button variant="icon" title={t("workflows.team.memberAgents.down")} disabled={i === agentIds.length - 1} onClick={() => move(i, i + 1)}>
              ↓
            </Button>
            <Button variant="icon" color="danger" title={t("common.delete")} onClick={() => onChange(agentIds.filter((x) => x !== id))}>
              <IconClose size={12} />
            </Button>
          </div>
        );
      })}
      {agentIds.length < MAX_AGENTS && addable.length > 0 && (
        <select value="" onChange={(e) => e.target.value && onChange([...agentIds, e.target.value])}>
          <option value="">{agentIds.length ? t("workflows.team.memberAgents.addBackup") : t("workflows.selectAgent")}</option>
          {addable.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name} · {t(`agents.provider.${a.provider || "claude"}`)}
              {availability[a.provider || "claude"] === false ? ` (${t("agents.provider.notInstalled")})` : ""}
            </option>
          ))}
        </select>
      )}
      <HelperText>{t("workflows.team.memberAgents.hint")}</HelperText>
    </>
  );
}
