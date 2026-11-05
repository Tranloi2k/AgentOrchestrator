/**
 * The editor assistant's pure parts: how the chosen agent is locked down, the prompt it gets and
 * how its answer is split into a reply and a proposed config. No store imports, so it's testable
 * without spawning a CLI or touching the config files.
 */
import { settingsForLevel } from "../agents/access.js";

export const ASSISTANT_TARGETS = ["workflow", "agent"];

/** Prefix of the run/task ids an assistant call runs under; run-store keeps their logs off the wire. */
export const ASSISTANT_RUN_PREFIX = "assistant:";

const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 8000;

/**
 * The assistant only writes text: it runs read-only with every tool blocked and without plugins.
 */
export function lockDownAssistant(agent, knownTools) {
  return {
    ...agent,
    ...settingsForLevel("read"),
    toolPolicy: "allowlist",
    allowedTools: [],
    disallowedTools: [...knownTools],
    pluginIds: [],
    spawnPolicy: null,
  };
}

/** Chat history as sent by the client, trimmed to something a prompt can carry. */
export function normalizeMessages(input) {
  return (Array.isArray(input) ? input : [])
    .filter((m) => m && typeof m.content === "string" && m.content.trim())
    .slice(-MAX_MESSAGES)
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content.slice(0, MAX_MESSAGE_CHARS) }));
}

/**
 * Splits the answer into the text shown in the chat and the config in its last ```json block.
 * `proposal` is null when there's no block; `parseError` is set when the block isn't valid JSON
 * (or isn't an object), so the chat can say why nothing was applied.
 */
export function parseAssistantReply(text) {
  const raw = String(text || "");
  const blocks = [...raw.matchAll(/```json\s*\n([\s\S]*?)```/gi)];
  if (!blocks.length) return { reply: raw.trim(), proposal: null, parseError: null };
  const last = blocks.at(-1);
  const reply = (raw.slice(0, last.index) + raw.slice(last.index + last[0].length)).trim();
  try {
    const proposal = JSON.parse(last[1]);
    if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) return { reply, proposal: null, parseError: "notAnObject" };
    return { reply, proposal, parseError: null };
  } catch (err) {
    return { reply, proposal: null, parseError: err.message };
  }
}

const WORKFLOW_GUIDE = `Bạn là trợ lý giúp người dùng thiết kế WORKFLOW trong ứng dụng Agent Orchestrator (điều phối nhiều agent CLI: claude, codex, gemini).

Có hai loại workflow (trường "type"):
1. "pipeline" — một đồ thị các bước:
   - "nodes": [{ "id", "agentId", "name", "promptTemplate", "kind": "agent"|"router", "autoStart", "calleeNodeIds", "fallbackAgentIds", "retries", "retryDelaySec", "timeoutSec", "tokenBudget" }]
     • id: chuỗi ngắn duy nhất (vd "n1"). agentId: BẮT BUỘC là id của một agent có sẵn bên dưới.
     • name: chữ thường, không dấu cách (vd "researcher"); các bước sau tham chiếu đầu ra bằng {{nodes.researcher}}.
     • promptTemplate: hướng dẫn cho bước. Biến: {{prompt}} = yêu cầu gốc khi chạy, {{previous}} = đầu ra (các) bước ngay trước, {{nodes.<name>}} = đầu ra một bước phía trước, {{input.<name>}} = một input khai báo trong "inputs". Bước có bước trước mà prompt không trống thì phải dùng {{previous}} hoặc {{nodes.x}}.
     • kind "router": đọc đầu vào rồi chọn MỘT nhánh ra (ứng dụng tự yêu cầu nó trả lời "ROUTE: <nhãn>"); mỗi cạnh ra của router phải có "condition" (nhãn ngắn, khác nhau). CHỈ cạnh ra của router được có "condition"; cạnh từ node "agent" để condition "".
     • autoStart false: bước chỉ chạy khi bước khác gọi nó qua calleeNodeIds (không có cạnh nối).
     • calleeNodeIds: các bước mà bước này có thể gọi giữa chừng (ask_agent) và đợi trả lời.
   - "edges": [{ "id", "from", "to", "condition", "loop", "maxIterations" }]
     • Đồ thị không được có chu trình, trừ cạnh "loop": true quay về một bước phía trước (maxIterations 1–20), chạy lại mọi bước ở giữa.
     • Lặp CÓ ĐIỀU KIỆN (vd "review chưa đạt thì làm lại"): bước đánh giá phải là "router", có một cạnh loop (condition vd "chua-dat") quay về bước cần làm lại và một cạnh thường (condition vd "dat") đi tiếp tới bước kế. Cạnh loop từ node "agent" thường thì LUÔN lặp đủ maxIterations lần.
2. "team" — một coordinator giao việc cho các member:
   - "team": { "coordinator": { "agentId", "process" }, "members": [{ "alias", "agentIds": [agent chính, dự phòng...], "role" }] }
     • alias: chữ thường, không dấu cách, duy nhất. process: coordinator nên điều phối nhóm thế nào.
     • "members" có thể để trống: khi "spawnPolicy": { "enabled": true, "providers": ["claude", ...] } thì coordinator tự định nghĩa các agent con lúc chạy (tên, vai trò, hướng dẫn), giống Claude Code tạo subagent. Chỉ thêm member cho vị trí cố định người dùng muốn; không cần "blueprints".

Trường chung: "name", "description", "inputs": [{ "name", "label", "default", "required" }].
Không tự đặt các trường khác (isolation, limits, schedules) trừ khi người dùng yêu cầu; chúng sẽ được giữ như bản nháp.`;

const AGENT_GUIDE = `Bạn là trợ lý giúp người dùng cấu hình một AGENT trong ứng dụng Agent Orchestrator. Agent là một CLI (claude, codex hoặc gemini) chạy với cấu hình sau:
{ "name", "description", "provider": "claude"|"codex"|"gemini", "model", "accessLevel": "read"|"write"|"full", "allowedTools": [...], "appendSystemPrompt", "skillIds": [...], "pluginIds": [...] }
- accessLevel: read = chỉ đọc; write = sửa file trong thư mục làm việc; full = toàn quyền (chạy lệnh, mạng). Chọn mức thấp nhất đủ dùng.
- allowedTools: chỉ áp dụng cho claude; tool không có trong danh sách sẽ bị chặn. "Task" cho phép tạo sub-agent — chỉ thêm khi thật cần.
- appendSystemPrompt: hướng dẫn riêng của agent (vai trò, cách làm, định dạng đầu ra). Viết cụ thể, có thể nhiều dòng.
- model: dùng đúng giá trị "value" trong danh sách model của provider; để "" nếu muốn mặc định.
- skillIds / pluginIds: chỉ dùng id có trong danh sách bên dưới.`;

const ANSWER_RULES = `Cách trả lời:
- Trả lời bằng ngôn ngữ người dùng đang dùng, RẤT ngắn: tối đa 2–3 câu nói đã làm gì. Không liệt kê lại từng trường, không nhắc lại cấu hình (nó đã hiện trong form), không dùng tiêu đề/markdown dài.
- Khi đề xuất hoặc sửa cấu hình, kết thúc câu trả lời bằng ĐÚNG MỘT khối \`\`\`json chứa TOÀN BỘ cấu hình mới (không phải chỉ phần thay đổi), sẽ được điền thẳng vào form.
- Nếu người dùng chỉ hỏi hoặc bạn cần hỏi lại cho rõ, KHÔNG kèm khối json.
- Không dùng tool, không đọc file — chỉ trả lời bằng văn bản.`;

/**
 * The whole prompt for one assistant turn: role + schema, what exists to pick from, the form as it
 * stands and the conversation so far (the client sends all of it each turn; no CLI session).
 */
export function buildAssistantPrompt({ target, context, draft, messages }) {
  const transcript = messages
    .map((m) => `${m.role === "assistant" ? "TRỢ LÝ" : "NGƯỜI DÙNG"}:\n${m.content}`)
    .join("\n\n");
  return [
    target === "workflow" ? WORKFLOW_GUIDE : AGENT_GUIDE,
    ANSWER_RULES,
    `## Dữ liệu có sẵn\n\`\`\`json\n${JSON.stringify(context, null, 2)}\n\`\`\``,
    `## Bản nháp hiện tại trong form\n\`\`\`json\n${JSON.stringify(draft || {}, null, 2)}\n\`\`\``,
    `## Hội thoại\n${transcript}\n\nTRỢ LÝ:`,
  ].join("\n\n");
}

/**
 * The draft as the assistant should see it: node positions are editor noise, and a workflow's
 * isolation/limits/schedules aren't its business unless asked.
 */
export function compactDraft(target, draft) {
  if (!draft || typeof draft !== "object") return {};
  if (target === "agent") {
    const { id, accessVersion, disallowedTools, toolPolicy, ...rest } = draft;
    return rest;
  }
  const { id, ...rest } = draft;
  return {
    ...rest,
    nodes: (draft.type === "team" ? [] : draft.nodes || []).map(({ x, y, ...n }) => n),
    edges: draft.type === "team" ? [] : draft.edges || [],
  };
}
