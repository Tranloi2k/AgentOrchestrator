/**
 * The part of a Team coordinator's tool descriptions that says who it can hand work to: its fixed
 * members (ask_agent) and the blueprints it may spawn (spawn_agent), and when to use which. Pure,
 * so mcp-bridge.js can put it into both tools and tests can read it.
 *
 * members:    [{ id, name, description }] as AGENT_BRIDGE_CALLABLE lists them (team members only)
 * blueprints: [{ name, role, accessLevel, providers: ["gemini", "claude (sonnet)"] }]
 */
export function teamGuide({ members = [], blueprints = [] } = {}) {
  if (!blueprints.length) return "";
  const blueprintLines = blueprints.map(
    (b) => `- blueprint="${b.name}" (quyền ${b.accessLevel}): ${String(b.role || "").replace(/\.$/, "")}. Provider theo thứ tự: ${b.providers.join(" → ")}.`
  );
  if (!members.length) {
    return [
      "Team này KHÔNG có thành viên cố định: bạn tự tạo các thành viên công việc cần bằng spawn_agent với một blueprint dưới đây (mỗi phần việc một workItemId).",
      "Blueprint:",
      ...blueprintLines,
    ].join("\n");
  }
  return [
    "Bạn có hai cách giao việc:",
    `- Thành viên cố định (ask_agent, agentId = ${members.map((m) => `"${m.id}"`).join(", ")}): dùng cho các vị trí cố định của Team, đúng vai trò đã ghi cho từng người.`,
    "- Blueprint (spawn_agent với blueprint + workItemId): dùng cho mọi việc khác mà công việc cần, khi không có thành viên cố định nào hợp vai trò đó.",
    "Đừng tạo agent từ blueprint cho việc mà một thành viên cố định đã đảm nhận.",
    "Blueprint:",
    ...blueprintLines,
  ].join("\n");
}
