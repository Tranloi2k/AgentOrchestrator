import { getAgent } from "../agents/agents.store.js";

/** How a node is named in logs and to other agents: a team member by its alias, the team's
 * coordinator and pipeline nodes by their agent's name. */
export function nodeTitle(node) {
  const agentName = getAgent(node.agentId)?.name || node.agentId;
  if (node.alias) return `${node.alias} (${agentName})`;
  if (node.teamRole === "coordinator") return `🧭 ${agentName}`;
  return `${node.kind === "router" ? "🔀 " : ""}${agentName}`;
}
