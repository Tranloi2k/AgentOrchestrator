#!/usr/bin/env node
/**
 * Agent-to-agent bridge — a tiny stdio MCP server spawned as a side-process of a running
 * `claude -p` agent (a node inside a workflow run). It exposes exactly one tool, `ask_agent`,
 * which lets that node call another node's agent in the SAME workflow synchronously (send a
 * question, block until the callee's full answer comes back, then keep going) — real
 * two-way agent interaction, on top of the one-directional workflow-graph edges.
 *
 * Wiring: orchestrator.js spawns `claude` with `--mcp-config <inline json>` pointing back
 * at this file, and passes context (which workflow/run/node is calling, which sibling nodes
 * it's allowed to call — set per-node in the Workflow editor, not on the agent itself — and
 * how deep the call chain already is) via environment variables — see runClaude() /
 * buildAgentBridgeConfig() in orchestrator.js.
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
      "Dùng khi bạn cần ý kiến, dữ liệu, hoặc kết quả cụ thể từ agent chuyên trách khác trước khi làm tiếp.\n\n" +
      "Các agent bạn được phép hỏi:\n" +
      (callableList || "(không có)"),
    inputSchema: {
      agentId: z.string().describe("id chính xác của agent muốn hỏi, lấy từ danh sách ở trên"),
      question: z.string().describe("Câu hỏi / nhiệm vụ cụ thể muốn agent đó thực hiện và trả lời"),
    },
  },
  async ({ agentId, question }) => {
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
          cwd: CWD,
          depth: DEPTH,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        return { content: [{ type: "text", text: `Lỗi: ${data.error || res.statusText}` }], isError: true };
      }
      return { content: [{ type: "text", text: data.answer || "(agent kia không trả lời gì)" }] };
    } catch (err) {
      return { content: [{ type: "text", text: `Lỗi kết nối agent-bridge: ${err.message}` }], isError: true };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
