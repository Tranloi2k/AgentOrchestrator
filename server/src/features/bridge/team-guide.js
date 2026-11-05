/**
 * The part of a Team coordinator's tool descriptions that says who it can hand work to: its fixed
 * members (ask_agent), the blueprints it may spawn and the agents it may define itself
 * (spawn_agent), and when to use which. Pure, so mcp-bridge.js can put it into both tools and
 * tests can read it.
 *
 * members:    [{ id, name, description }] as AGENT_BRIDGE_CALLABLE lists them (team members only)
 * blueprints: [{ name, role, accessLevel, providers: ["gemini", "claude (sonnet)"] }]
 * adHoc:      the Team allows providers to spawn from, so the coordinator may define agents itself
 */
export function teamGuide({ members = [], blueprints = [], adHoc = false } = {}) {
  if (!blueprints.length && !adHoc) return "";
  const blueprintLines = blueprints.length
    ? [
        "Blueprint:",
        ...blueprints.map(
          (b) => `- blueprint="${b.name}" (quyền ${b.accessLevel}): ${String(b.role || "").replace(/\.$/, "")}. Provider theo thứ tự: ${b.providers.join(" → ")}.`
        ),
      ]
    : [];
  const how =
    blueprints.length && adHoc
      ? "spawn_agent với blueprint + workItemId khi có blueprint hợp vai trò; không có thì tự định nghĩa agent (name + role + instructions + workItemId)"
      : blueprints.length
        ? "spawn_agent với blueprint + workItemId"
        : "spawn_agent, tự định nghĩa agent: name + role + instructions + workItemId";
  if (!members.length) {
    return [
      `Team này KHÔNG có thành viên cố định: bạn tự tạo các thành viên công việc cần bằng ${how} (mỗi phần việc một workItemId).`,
      ...(adHoc ? ["Chia việc theo vai trò rõ ràng, mỗi agent một chuyên môn; viết instructions như system prompt cho chuyên gia đó."] : []),
      ...blueprintLines,
    ].join("\n");
  }
  return [
    "Bạn có hai cách giao việc:",
    `- Thành viên cố định (ask_agent, agentId = ${members.map((m) => `"${m.id}"`).join(", ")}): dùng cho các vị trí cố định của Team, đúng vai trò đã ghi cho từng người.`,
    `- Agent tạo mới (${how}): dùng cho mọi việc khác mà công việc cần, khi không có thành viên cố định nào hợp vai trò đó.`,
    "Đừng tạo agent mới cho việc mà một thành viên cố định đã đảm nhận.",
    ...blueprintLines,
  ].join("\n");
}
