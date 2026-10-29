import { requireInternalToken } from "../../core/security.js";
import { askAgent, spawnAgent, completeWorkItem } from "../runs/executor.js";

/**
 * Internal-only endpoints hit by mcp-bridge.js (a side-process of a running agent). They need the
 * per-start token only bridge processes receive; the UI never calls them.
 */
export function register(app) {
  /** The `ask_agent` tool: makes agent-to-agent calls synchronous — the caller's tool call blocks
   * until this resolves with the callee's answer. */
  app.post("/api/internal/ask-agent", requireInternalToken, async (req, res) => {
    const { runId, workflowId, callerNodeId, callerTaskId, targetNodeId, question, workItemId, parentWorkItemId, reviewOf, cwd, depth } = req.body || {};
    if (!runId || !workflowId || !callerNodeId || !targetNodeId || !question || !workItemId) {
      return res.status(400).json({ error: "thiếu runId/workflowId/callerNodeId/targetNodeId/question/workItemId" });
    }
    try {
      res.json(
        await askAgent({ runId, workflowId, callerNodeId, callerTaskId, targetNodeId, question, workItemId, parentWorkItemId, reviewOf, cwd, depth: depth || 0 })
      );
    } catch (err) {
      res.status(409).json({ error: err.message });
    }
  });

  /** The `complete_work_item` tool: test and merge one work item's worktree (Team, isolation on). */
  app.post("/api/internal/complete-work-item", requireInternalToken, async (req, res) => {
    const { sessionId, workItemId } = req.body || {};
    if (!sessionId || !workItemId) return res.status(400).json({ error: "thiếu sessionId/workItemId" });
    try {
      res.json(await completeWorkItem({ sessionId, workItemId }));
    } catch (err) {
      res.status(409).json({ error: err.message });
    }
  });

  /** The `spawn_agent` tool. The caller is identified by its bridge session id alone; policy,
   * depth and cwd come from the server's own record of that session. */
  app.post("/api/internal/spawn-agent", requireInternalToken, async (req, res) => {
    const { sessionId, provider, model, tools, accessLevel, prompt, title } = req.body || {};
    if (!sessionId || !prompt) {
      return res.status(400).json({ error: "thiếu sessionId/prompt" });
    }
    try {
      res.json(await spawnAgent({ sessionId, provider, model, tools, accessLevel, prompt: String(prompt), title }));
    } catch (err) {
      res.status(409).json({ error: err.message });
    }
  });
}
