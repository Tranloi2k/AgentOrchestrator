/**
 * How a workflow node is labelled on a canvas: team members by alias (with their agent
 * underneath), the team coordinator and pipeline nodes by agent name.
 */
export function nodeDisplay(node, agents, t) {
  const agent = agents.find((a) => a.id === node.agentId);
  const agentName = agent?.name || t("workflows.deletedAgent");
  const provider = agent?.provider || "claude";
  if (node.alias) return { title: node.alias, subtitle: agentName, provider };
  if (node.teamRole === "coordinator") return { title: agentName, subtitle: t("workflows.team.coordinatorShort"), provider };
  const subtitle = node.kind === "router" ? t("kind.router") : node.autoStart === false ? t("workflows.manualBadge") : "";
  return { title: agentName, subtitle, provider };
}

/** Delegation edges (dashed "hands work to" lines) for every node's callees. */
export function callEdgesOf(nodes) {
  return nodes.flatMap((n) => (n.calleeNodeIds || []).map((to) => ({ from: n.id, to })));
}
