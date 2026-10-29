#!/usr/bin/env node
/**
 * Agent-to-agent bridge — a tiny stdio MCP server spawned as a side-process of a running agent.
 * It exposes up to two tools, depending on what the server configured for this agent:
 *  - `ask_agent`: call another node's agent in the SAME workflow synchronously (send a question,
 *    block until the callee's full answer comes back, then keep going) — real two-way agent
 *    interaction, on top of the one-directional workflow-graph edges.
 *  - `spawn_agent`: as a supervisor, create a fresh agent on the fly — any provider/model/tool
 *    set inside the whitelist the user gave this agent — run a task on it and wait for the answer.
 *
 * Provider-agnostic: this is a plain stdio MCP server, so both CLIs run the exact same process
 * and only the flags pointing at it differ. Claude Code gets it via `--mcp-config <inline
 * json>`; Codex via `-c mcp_servers.agent-bridge.*` overrides (which also need
 * `default_tools_approval_mode="approve"`, since `codex exec` has no TTY to approve MCP calls
 * on); Gemini via a throwaway system-settings file with the server marked `trust: true`, since
 * headless gemini denies any tool call that would need approval. Context arrives through the
 * environment in every case. See buildAgentBridgeContext(), writeGeminiBridgeSettings(),
 * buildClaudeBridgeArgs() and buildCodexBridgeArgs() in cli-runners.js.
 */
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BRIDGE_URL = process.env.AGENT_BRIDGE_URL || "http://127.0.0.1:5175";
const BRIDGE_TOKEN = process.env.AGENT_BRIDGE_TOKEN || "";
const SESSION_ID = process.env.AGENT_BRIDGE_SESSION || "";
const RUN_ID = process.env.AGENT_BRIDGE_RUN_ID || "";
const CALLER_TASK_ID = process.env.AGENT_BRIDGE_TASK_ID || "";
const WORKFLOW_ID = process.env.AGENT_BRIDGE_WORKFLOW_ID || "";
const CALLER_NODE_ID = process.env.AGENT_BRIDGE_CALLER_NODE_ID || "";
const DEPTH = Number(process.env.AGENT_BRIDGE_DEPTH || "0");
const CWD = process.env.AGENT_BRIDGE_CWD || process.cwd();
const parseJson = (value, fallback) => {
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};
const CALLABLE = parseJson(process.env.AGENT_BRIDGE_CALLABLE, []);
const SPAWN_POLICY = parseJson(process.env.AGENT_BRIDGE_SPAWN_POLICY, null);

/**
 * POSTs JSON to the orchestrator server. Uses node:http rather than fetch on purpose: fetch
 * gives up waiting for response headers after 5 minutes, and both tools here legitimately block
 * for as long as the other agent takes.
 */
function postJson(pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      new URL(pathname, BRIDGE_URL),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
          "x-orchestrator-token": BRIDGE_TOKEN,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          let data = {};
          try {
            data = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          } catch {
            /* non-JSON error body */
          }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data });
        });
      }
    );
    req.on("error", reject);
    req.end(payload);
  });
}

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });

const server = new McpServer({ name: "agent-bridge", version: "1.0.0" });

if (CALLABLE.length) {
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
        callableList,
      inputSchema: {
        agentId: z.string().describe("id chính xác của agent muốn hỏi, lấy từ danh sách ở trên"),
        question: z.string().describe("Câu hỏi / nhiệm vụ cụ thể muốn agent đó thực hiện và trả lời"),
        workItemId: z.string().min(1).max(80).describe("Mã ổn định của một công việc logic, ví dụ feature-login-ui; không đổi mã để giao cùng việc cho agent khác"),
        parentWorkItemId: z.string().min(1).max(80).optional().describe("Bắt buộc khi đây là subtask mới được tách ra; dùng workItemId của việc cha, hoặc root nếu tách trực tiếp từ yêu cầu gốc"),
      },
    },
    async ({ agentId, question, workItemId, parentWorkItemId }) => {
      try {
        const { ok, status, data } = await postJson("/api/internal/ask-agent", {
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
        });
        if (!ok) return text(`Lỗi: ${data.error || `HTTP ${status}`}`, true);
        if (!data.ok) {
          const canFailOver = ["quota", "provider_unavailable"].includes(data.failureReason);
          const guidance = canFailOver
            ? ` Có thể gọi agent khác với CÙNG workItemId="${workItemId}" vì hệ thống đã mở khóa failover.`
            : " Không được giao công việc này cho agent khác; hãy thử lại cùng agent hoặc báo lỗi cho người dùng.";
          return text(`Agent không hoàn thành (${data.failureReason || "agent_error"}).${guidance}`, true);
        }
        return text(data.answer || "(agent kia không trả lời gì)");
      } catch (err) {
        return text(`Lỗi kết nối agent-bridge: ${err.message}`, true);
      }
    }
  );
}

if (SPAWN_POLICY) {
  const p = SPAWN_POLICY;
  const list = (items) => (items?.length ? items.join(", ") : "(không có)");
  const levels = ["read", "write", "full"];
  const allowedLevels = levels.slice(0, levels.indexOf(p.maxAccessLevel || "read") + 1);
  const policyText = [
    `- provider: ${list(p.providers)}`,
    p.providers?.includes("claude") && `- model Claude: mặc định của CLI (bỏ trống)${p.claudeModels?.length ? ", " + p.claudeModels.join(", ") : ""}`,
    p.providers?.includes("codex") && `- model Codex: mặc định của CLI (bỏ trống)${p.codexModels?.length ? ", " + p.codexModels.join(", ") : ""}`,
    p.providers?.includes("gemini") && `- model Gemini (agy): mặc định của CLI (bỏ trống)${p.geminiModels?.length ? ", " + p.geminiModels.join(", ") : ""}`,
    `- accessLevel: ${allowedLevels.join(", ")} (read = chỉ đọc, write = sửa trong workspace, full = toàn quyền; bỏ trống = read; không vượt quá quyền của bạn)`,
    p.providers?.includes("claude") && `- tool cho agent Claude: ${list(p.toolCeiling)} (bỏ trống "tools" = tất cả tool này; không bao giờ có Task)`,
    `- tối đa ${p.maxAgents} agent cho cả run`,
    p.tokenBudget ? `- ngân sách ${p.tokenBudget} token (input + output + ghi cache) cho tất cả agent được tạo trong run` : null,
  ]
    .filter(Boolean)
    .join("\n");

  server.registerTool(
    "spawn_agent",
    {
      title: "Tạo một agent mới để giao việc",
      description:
        "Tạo một agent MỚI (chọn provider, model, tool) để làm một phần việc, rồi CHỜ nhận kết quả của nó. " +
        "Dùng khi việc có thể tách thành phần độc lập, hoặc khi phần việc hợp với một provider/model khác hơn. " +
        "Agent mới KHÔNG thấy hội thoại của bạn: prompt phải tự đầy đủ bối cảnh, mục tiêu và nói rõ cần trả về gì. " +
        "Nhiều lời gọi có thể chạy song song. Không tạo agent cho việc nhỏ bạn tự làm nhanh hơn.\n\n" +
        "Giới hạn được phép (hệ thống kiểm tra, ngoài danh sách sẽ bị từ chối):\n" +
        policyText,
      inputSchema: {
        provider: z.string().optional().describe(`Provider của agent mới: ${list(p.providers)}. Bắt buộc nếu được phép nhiều hơn 1 provider.`),
        model: z.string().optional().describe("Model, bỏ trống để dùng model mặc định của CLI"),
        accessLevel: z.enum(["read", "write", "full"]).optional().describe("Mức truy cập của agent mới: read (mặc định), write hoặc full — không vượt quá mức của bạn. Cần sửa file thì truyền write."),
        tools: z.array(z.string()).optional().describe("Chỉ cho Claude: danh sách tool, phải nằm trong danh sách được phép"),
        title: z.string().max(80).optional().describe("Tên ngắn cho phần việc, hiện trên giao diện"),
        prompt: z.string().min(1).describe("Nhiệm vụ đầy đủ cho agent mới"),
      },
    },
    async ({ provider, model, accessLevel, tools, title, prompt }) => {
      try {
        const { ok, status, data } = await postJson("/api/internal/spawn-agent", {
          sessionId: SESSION_ID,
          provider,
          model,
          accessLevel,
          tools,
          title,
          prompt,
        });
        if (!ok) return text(`Không tạo được agent: ${data.error || `HTTP ${status}`}`, true);
        const u = data.usage || {};
        const footer = `\n\n---\n(Đã tạo ${u.spawned}/${u.maxAgents} agent trong run này; agent con đã dùng ${u.tokensUsed}${u.tokenBudget ? "/" + u.tokenBudget : ""} token.)`;
        if (!data.ok) return text(`Agent mới không hoàn thành (${data.failureReason || "agent_error"}).${data.answer ? "\n\n" + data.answer : ""}${footer}`, true);
        return text((data.answer || "(agent mới không trả lời gì)") + footer);
      } catch (err) {
        return text(`Lỗi kết nối agent-bridge: ${err.message}`, true);
      }
    }
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
