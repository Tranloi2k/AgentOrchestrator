import React from "react";
import { ProviderIcon } from "../../../shared/Icons.jsx";
import { usePreferences } from "../../../app/PreferencesContext.jsx";

/**
 * Hub diagram of a Team workflow: the coordinator on top, its members fanning out below, and a
 * "create agents" card when the team may spawn. A team has no data edges, so the generic graph
 * canvas just stacks it in a column; this shape is what a team actually is.
 *
 * Used read-only (workflow cards, Run preview, a running run — `statusOf` colours each card) and
 * interactively in the Team editor (`selected` / `onSelect` / `onAddMember`).
 *
 *   coordinator: { agentId, subtitle? }
 *   members:     [{ key, alias, agentId, role }]
 *   spawn:       { enabled, providers } | null
 *   spawnCount:  agents spawned so far in a run (optional)
 */
export default function TeamDiagram({
  coordinator,
  members,
  spawn,
  agents,
  statusOf,
  spawnCount,
  selected,
  onSelect,
  onAddMember,
  addLabel,
  hint = null,
  compact = false,
}) {
  const { t } = usePreferences();
  const agent = (id) => agents.find((a) => a.id === id);
  const agentName = (id) => agent(id)?.name || t("workflows.notSelected");
  const interactive = !!onSelect;

  const card = (key, { icon, title, subtitle, status, className = "" }) => {
    const classes = ["team-node", className, selected === key ? "selected" : "", status ? `team-node-status-${status}` : "", interactive ? "" : "readonly"]
      .filter(Boolean)
      .join(" ");
    const body = (
      <>
        {icon && <span className="team-node-icon">{icon}</span>}
        <span className="team-node-text">
          <span className="team-node-title">{title}</span>
          {subtitle && <span className="team-node-subtitle">{subtitle}</span>}
        </span>
        {status && <span className={`team-node-dot dot-${status}`} title={t(`status.${status}`)} />}
      </>
    );
    return interactive ? (
      <button type="button" className={classes} onClick={() => onSelect(key)}>
        {body}
      </button>
    ) : (
      <div className={classes}>{body}</div>
    );
  };

  const providerIcon = (id, size) => (id ? <ProviderIcon provider={agent(id)?.provider || "claude"} size={size} /> : "🧭");
  const showSpawn = interactive || spawn?.enabled;

  return (
    <div className={`team-diagram ${compact ? "team-diagram-compact" : ""}`}>
      {card("coordinator", {
        className: "team-node-coordinator",
        icon: providerIcon(coordinator.agentId, 18),
        title: agentName(coordinator.agentId),
        subtitle: coordinator.subtitle ?? t("workflows.team.coordinatorShort"),
        status: statusOf?.("coordinator"),
      })}
      {(members.length > 0 || showSpawn || onAddMember) && (
        <>
          <div className="team-diagram-stem" />
          <div className="team-members">
            {members.map((m) => (
              <div key={m.key} className="team-member-slot">
                {card(m.key, {
                  icon: providerIcon(m.agentId, 16),
                  title: m.alias || t("workflows.team.unnamedMember"),
                  subtitle: m.role || agentName(m.agentId),
                  status: statusOf?.(m.alias),
                  className: interactive && (!m.alias || !m.role) ? "team-node-incomplete" : "",
                })}
              </div>
            ))}
            {onAddMember && (
              <div className="team-member-slot">
                <button type="button" className="team-node team-node-add" onClick={onAddMember}>
                  {addLabel}
                </button>
              </div>
            )}
            {showSpawn && (
              <div className="team-member-slot">
                {card("spawn", {
                  className: `team-node-spawn ${spawn?.enabled ? "" : "is-off"}`,
                  icon: "🧬",
                  title: t("workflows.team.spawnCard"),
                  subtitle: spawn?.enabled
                    ? spawnCount
                      ? t("workflows.team.spawnCard.count", { count: spawnCount })
                      : t("workflows.team.spawnCard.on", {
                          providers: (spawn.providers || []).map((p) => t(`agents.provider.${p}`)).join(", ") || "—",
                        })
                    : t("workflows.team.spawnCard.off"),
                })}
              </div>
            )}
          </div>
        </>
      )}
      {hint && <p className="team-diagram-hint">{hint}</p>}
    </div>
  );
}

/** TeamDiagram props from a saved team workflow's node list (or a run's snapshot of it). */
export function teamFromNodes(nodes) {
  const coord = nodes.find((n) => n.teamRole === "coordinator") || {};
  return {
    coordinator: { agentId: coord.agentId },
    members: nodes.filter((n) => n.teamRole === "member").map((n) => ({ key: n.id, alias: n.alias, agentId: n.agentId, role: n.role })),
    spawn: coord.spawnPolicy || null,
  };
}
