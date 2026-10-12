#!/usr/bin/env node
/**
 * Agent-to-agent bridge — a tiny stdio MCP server spawned as a side-process of a running agent
 * (a node inside a workflow run). It exposes exactly one tool, `ask_agent`, which lets that
 * node call another node's agent in the SAME workflow synchronously (send a question, block
 * until the callee's full answer comes back, then keep going) — real two-way agent
 * interaction, on top of the one-directional workflow-graph edges.
 *
 * Provider-agnostic: this is a plain stdio MCP server, so both CLIs run the exact same process
 * and only the flags pointing at it differ. Claude Code gets it via `--mcp-config <inline
 * json>`; Codex via `-c mcp_servers.agent-bridge.*` overrides (which also need
 * `default_tools_approval_mode="approve"`, since `codex exec` has no TTY to approve MCP calls
 * on). Context — which workflow/run/node is calling, which sibling nodes it may call (set
 * per-node in the Workflow editor, not on the agent), and how deep the call chain already is —
 * arrives through the environment either way. See buildAgentBridgeContext(),
 * buildClaudeBridgeArgs() and buildCodexBridgeArgs() in orchestrator.js.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BRIDGE_URL = process.env.AGENT_BRIDGE_URL || "http://localhost:5175";
const RUN_ID = process.env.AGENT_BRIDGE_RUN_ID || "";
const CALLER_TASK_ID = process.env.AGENT_BRIDGE_TASK_ID || "";
const WORKFLOW_ID = process.env.AGENT_BRIDGE_WORKFLOW_ID || "";
const CALLER_NODE_ID = process.env.AGENT_BRIDGE_CALLER_NODE_ID || "";
const DEPTH = Number(process.env.AGENT_BRIDGE_DEPTH || "0");
const CWD = process.env.AGENT_BRIDGE_CWD || process.cwd();
let CALLABLE = [];
try {
  CALLABLE = JSON.parse(process.env.AGENT_BRIDGE_CALLABLE || "[]");
} catch {
  CALLABLE = [];
}

const server = new McpServer({ name: "agent-bridge", version: "1.0.0" });

const callableList = CALLABLE.map((n) => `- id="${n.id}" tên="${n.name}" — ${n.description || ""}`).join("\n");

server.registerTool(
  "ask_agent",
  {
    title: "Hỏi một agent khác trong workflow",
    description:
      "Gọi trực tiếp một agent khác (1 bước khác) trong CÙNG workflow này, gửi câu hỏi/nhiệm vụ, và CHỜ nhận câu trả lời đầy đủ của nó rồi mới tiếp tục việc của bạn. " +
      "Mỗi công việc logic chỉ được thuộc MỘT agent. Giữ nguyên workItemId khi yêu cầu cùng agent làm tiếp/sửa tiếp. " +
      "Không được giao cùng workItemId cho agent khác, trừ khi lần trước được hệ thống xác nhận thất bại vì hết quota/provider không khả dụng. " +
      "Nếu chia yêu cầu gốc thành công việc mới thật sự khác, dùng workItemId mới và khai báo parentWorkItemId.\n\n" +
      "Các agent bạn được phép hỏi:\n" +
      (callableList || "(không có)"),
    inputSchema: {
      agentId: z.string().describe("id chính xác của agent muốn hỏi, lấy từ danh sách ở trên"),
      question: z.string().describe("Câu hỏi / nhiệm vụ cụ thể muốn agent đó thực hiện và trả lời"),
      workItemId: z.string().min(1).max(80).describe("Mã ổn định của một công việc logic, ví dụ feature-login-ui; không đổi mã để giao cùng việc cho agent khác"),
      parentWorkItemId: z.string().min(1).max(80).optional().describe("Bắt buộc khi đây là subtask mới được tách ra; dùng workItemId của việc cha, hoặc root nếu tách trực tiếp từ yêu cầu gốc"),
    },
  },
  async ({ agentId, question, workItemId, parentWorkItemId }) => {
    try {
      const res = await fetch(`${BRIDGE_URL}/api/internal/ask-agent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId: RUN_ID,
          callerTaskId: CALLER_TASK_ID,
          workflowId: WORKFLOW_ID,
          callerNodeId: CALLER_NODE_ID,
          targetNodeId: agentId,
          question,
          workItemId,
          parentWorkItemId,
          cwd: CWD,
          depth: DEPTH,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { content: [{ type: "text", text: `Lỗi: ${data.error || res.statusText}` }], isError: true };
      }
      if (!data.ok) {
        const canFailOver = ["quota", "provider_unavailable"].includes(data.failureReason);
        const guidance = canFailOver
          ? ` Có thể gọi agent khác với CÙNG workItemId="${workItemId}" vì hệ thống đã mở khóa failover.`
          : " Không được giao công việc này cho agent khác; hãy thử lại cùng agent hoặc báo lỗi cho người dùng.";
        return {
          content: [{ type: "text", text: `Agent không hoàn thành (${data.failureReason || "agent_error"}).${guidance}` }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: data.answer || "(agent kia không trả lời gì)" }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Lỗi kết nối agent-bridge: ${err.message}` }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
