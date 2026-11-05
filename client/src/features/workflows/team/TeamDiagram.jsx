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
 *   blueprints:  [{ key, name, role, accessLevel, providers: [{ provider }] }]: roles the
 *                coordinator may spawn; in a run, `blueprintStatusOf(name)` gives
 *                { status, provider } of its latest spawned agent
 *   flow:        in a run, its hand-overs in order (see teamFlow); once there is one, the diagram
 *                draws the run as it happened instead of the team's shape: numbered steps under
 *                the coordinator, parallel ones side by side, then `outcome` (see teamRunOutcome)
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
  blueprints = [],
  blueprintStatusOf,
  flow = null,
  outcome = null,
  onAddBlueprint,
  addBlueprintLabel,
  hint = null,
  compact = false,
}) {
  const { t } = usePreferences();
  const agent = (id) => agents.find((a) => a.id === id);
  const agentName = (id) => agent(id)?.name || t("workflows.notSelected");
  const interactive = !!onSelect;

  const card = (key, { icon, title, subtitle, meta = null, status, className = "" }) => {
    const classes = ["team-node", className, selected === key ? "selected" : "", status ? `team-node-status-${status}` : "", interactive ? "" : "readonly"]
      .filter(Boolean)
      .join(" ");
    const body = (
      <>
        {icon && <span className="team-node-icon">{icon}</span>}
        <span className="team-node-text">
          <span className="team-node-title">{title}</span>
          {subtitle && <span className="team-node-subtitle">{subtitle}</span>}
          {meta && <span className="team-node-meta">{meta}</span>}
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
  const coordinatorCard = card("coordinator", {
    className: "team-node-coordinator",
    icon: providerIcon(coordinator.agentId, 18),
    title: agentName(coordinator.agentId),
    subtitle: coordinator.subtitle ?? t("workflows.team.coordinatorShort"),
    status: statusOf?.("coordinator"),
  });

  // A run that has handed work out: draw what happened, in order.
  if (flow?.some((turn) => turn.groups.length)) {
    const memberOf = (nodeId) => members.find((m) => m.key === nodeId || m.alias === nodeId);
    const stepCard = ({ task, number, round, verdict, time }) => {
      const s = task.spawn;
      const member = s ? null : memberOf(task.nodeId);
      const provider = s ? s.provider || s.providers?.[0] || task.provider : task.provider || agent(member?.agentId)?.provider;
      return (
        <div key={task.id} className="team-flow-step">
          <span className="team-flow-num">{number}</span>
          {card(`step:${task.id}`, {
            icon: <ProviderIcon provider={provider || "claude"} size={16} />,
            title: s ? s.blueprint || s.provider || "agent" : member?.alias || task.nodeId,
            subtitle: (s ? s.role : member?.role) || null,
            meta: (
              <>
                {task.workItemId && <span className="team-flow-chip">{task.workItemId}</span>}
                {round > 1 && <span className="team-flow-chip team-flow-chip-round">{t("run.flow.round", { round })}</span>}
                {task.reviewOf && <span>{t("run.flow.reviews", { item: task.reviewOf })}</span>}
                {verdict && <span className={`team-flow-chip team-flow-verdict-${verdict}`}>{verdict === "passed" ? "PASS" : "FAIL"}</span>}
                {time && <span>{time}</span>}
              </>
            ),
            status: task.status,
            className: s ? "team-node-blueprint" : "",
          })}
        </div>
      );
    };
    return (
      <div className={`team-diagram team-diagram-flow ${compact ? "team-diagram-compact" : ""}`}>
        {coordinatorCard}
        {flow.map((turn, i) => (
          <React.Fragment key={turn.lead?.id || i}>
            {i > 0 && turn.lead && (
              <>
                <div className="team-flow-arrow is-done" />
                <div className="team-flow-message">💬 {turn.lead.title}</div>
              </>
            )}
            {turn.groups.map((group, g) => (
              <React.Fragment key={g}>
                <div className={`team-flow-arrow is-${groupStatus(group)}`} />
                {group.length > 1 ? (
                  <div className="team-flow-parallel">
                    <span className="team-flow-parallel-label">{t("run.flow.parallel", { count: group.length })}</span>
                    <div className="team-flow-parallel-steps">{group.map(stepCard)}</div>
                  </div>
                ) : (
                  stepCard(group[0])
                )}
              </React.Fragment>
            ))}
          </React.Fragment>
        ))}
        {outcome && (
          <>
            <div className="team-flow-arrow is-done" />
            <div className={`team-flow-outcome team-flow-outcome-${outcome.tone}`}>{t(outcome.key, outcome.params)}</div>
          </>
        )}
      </div>
    );
  }

  return (
    <div className={`team-diagram ${compact ? "team-diagram-compact" : ""}`}>
      {coordinatorCard}
      {(members.length > 0 || showSpawn || onAddMember || blueprints.length > 0) && (
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
            {(blueprints.length > 0 || onAddBlueprint) && <div className="team-blueprints-label">{t("workflows.blueprint.section")}</div>}
            {blueprints.map((b) => {
              const live = blueprintStatusOf?.(b.name);
              const first = live?.provider || b.providers?.[0]?.provider || "claude";
              return (
                <div key={b.key} className="team-member-slot">
                  {card(b.key, {
                    icon: <ProviderIcon provider={first} size={16} />,
                    title: b.name || t("workflows.blueprint.unnamed"),
                    subtitle: live?.provider
                      ? t("workflows.blueprint.ranOn", { provider: t(`agents.provider.${live.provider}`) })
                      : b.role || (b.providers || []).map((p) => t(`agents.provider.${p.provider}`)).join(" → "),
                    status: live?.status,
                    className: `team-node-blueprint ${interactive && (!b.name || !b.role || !b.providers?.length) ? "team-node-incomplete" : ""}`,
                  })}
                </div>
              );
            })}
            {onAddBlueprint && (
              <div className="team-member-slot">
                <button type="button" className="team-node team-node-add" onClick={onAddBlueprint}>
                  {addBlueprintLabel}
                </button>
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
    blueprints: (coord.blueprints || []).map((b) => ({ key: `bp:${b.name}`, ...b })),
  };
}

/** "passed" / "failed" from a review's last `REVIEW: PASS|FAIL` (or `VERDICT:`) line, else null. */
function reviewVerdict(text) {
  const last = [...String(text || "").matchAll(/(?:REVIEW|VERDICT)\s*:\s*\**\s*(PASS|FAIL|CHANGES[_ ]REQUESTED)/gi)].at(-1)?.[1]?.toUpperCase();
  return last ? (last === "PASS" ? "passed" : "failed") : null;
}

function elapsed(task, now) {
  if (!task.startedAt) return null;
  const sec = Math.max(0, Math.round(((task.endedAt || now) - task.startedAt) / 1000));
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${String(sec % 60).padStart(2, "0")}s`;
}

/**
 * For a run's TeamDiagram: its hand-overs (ask_agent calls and spawns) in the order they were
 * made, as turns (the first prompt, then each chat message) of groups; a group holds the steps
 * that ran at the same time. Each step is numbered in the run and knows its fix round per work
 * item, its review verdict and how long it took.
 */
export function teamFlow(tasks, now = Date.now()) {
  const turns = [];
  const rounds = new Map();
  let number = 0;
  for (const task of tasks) {
    if (task.kind === "followup" || (task.kind === "workflow-node" && task.nodeId === "coordinator")) {
      turns.push({ lead: task, groups: [] });
      continue;
    }
    if (task.kind !== "agent-call" && task.kind !== "agent-spawn") continue;
    if (!turns.length) turns.push({ lead: null, groups: [] });
    const target = task.kind === "agent-spawn" ? `spawn:${task.spawn?.blueprint || task.id}` : task.nodeId;
    const key = `${target}|${task.workItemId || task.id}`;
    rounds.set(key, (rounds.get(key) || 0) + 1);
    const start = task.startedAt || task.createdAt || 0;
    const step = {
      task,
      number: ++number,
      round: rounds.get(key),
      verdict: task.status === "done" && (task.reviewOf || /review/i.test(task.spawn?.blueprint || task.nodeId || "")) ? reviewVerdict(task.resultText) : null,
      time: elapsed(task, now),
      start,
      end: task.endedAt || (task.status === "running" ? now : start),
    };
    // Started before a step of the group above finished: they ran in parallel.
    const groups = turns.at(-1).groups;
    const last = groups.at(-1);
    if (last && start && last.some((x) => x.start && x.end > start)) last.push(step);
    else groups.push([step]);
  }
  return turns;
}

/**
 * How the connector into a group is drawn, as in a Pipeline canvas: flowing while one of its
 * steps runs, green once all are done, red when one failed.
 */
function groupStatus(group) {
  const statuses = group.map((s) => s.task.status);
  if (statuses.includes("running")) return "running";
  if (statuses.includes("error")) return "error";
  if (statuses.every((s) => s === "done")) return "done";
  return "pending";
}

/** How a Team run ended, for the bottom of its diagram: { tone, key, params }, or null while it runs. */
export function teamRunOutcome(run) {
  // Still running: the glowing card says so, there's no outcome yet.
  if (run.status === "running") return null;
  if (run.status === "error" || run.status === "cancelled") return { tone: "error", key: `status.${run.status}` };
  const review = run.review?.status;
  if (review === "pending") return { tone: "pending", key: "run.flow.outcome.pending", params: { count: run.review.files?.length || 0 } };
  if (review === "accepted") return { tone: "done", key: "run.flow.outcome.accepted" };
  if (review === "declined") return { tone: "muted", key: "run.flow.outcome.declined" };
  if (review === "no_changes") return { tone: "muted", key: "run.flow.outcome.noChanges" };
  return { tone: "done", key: "status.done" };
}

/**
 * For a run's TeamDiagram: a blueprint's latest spawned agent, as { status, provider } (the
 * provider that actually ran, once known), or undefined when it wasn't spawned.
 */
export function blueprintStatus(tasks, name) {
  const task = tasks.filter((x) => x.kind === "agent-spawn" && x.spawn?.blueprint === name).at(-1);
  return task ? { status: task.status, provider: task.spawn?.provider || null } : undefined;
}
