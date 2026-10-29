import { DEFAULT_CWD } from "../../core/config.js";
import { checkCwd } from "../../core/security.js";
import { prepareTargetBranch } from "../workspace/workspace.js";
import { listRuns, getRun, getUsageSummary, acceptRunReview, declineRunReview, deleteRun, clearRuns } from "./run-store.js";
import { startRun, startWorkflowRun, stopRun, resumeRun, continueRun, deleteChat } from "./executor.js";

/** Settles the branch a run lands on (creating a new one if asked); sends 400 and returns
 * undefined on a bad choice. */
async function resolveTargetBranch(cwd, body, res) {
  try {
    return await prepareTargetBranch(cwd || DEFAULT_CWD, { branch: body.targetBranch, newBranch: body.newBranch });
  } catch (err) {
    res.status(400).json({ error: err.message });
    return undefined;
  }
}

/** Wraps a run action that returns false for "no such run" and throws for "not now". */
function runAction(action, respond = () => ({ ok: true })) {
  return async (req, res) => {
    try {
      const ok = await action(req);
      if (!ok) return res.status(404).json({ error: "not found" });
      res.json(respond(req));
    } catch (err) {
      res.status(409).json({ error: err.message });
    }
  };
}
const withRun = (req) => ({ run: getRun(req.params.id) });

/** Run history, starting runs, and everything you can do to a run afterwards. */
export function register(app) {
  app.get("/api/runs", (req, res) => {
    res.json({ runs: listRuns() });
  });

  /** Token/cost usage rolled up from run history — per provider and per agent. */
  app.get("/api/usage", (req, res) => {
    res.json(getUsageSummary());
  });

  app.get("/api/runs/:id", (req, res) => {
    const run = getRun(req.params.id);
    if (!run) return res.status(404).json({ error: "not found" });
    res.json({ run });
  });

  app.post("/api/runs/:id/review/accept", runAction((req) => acceptRunReview(req.params.id), withRun));
  app.post("/api/runs/:id/review/decline", runAction((req) => declineRunReview(req.params.id), withRun));
  app.delete("/api/runs/:id", runAction((req) => deleteRun(req.params.id)));

  app.delete("/api/runs", (req, res) => {
    res.json(clearRuns());
  });

  app.post("/api/run", async (req, res) => {
    const { prompt, agentId, decompose, cwd } = req.body || {};
    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ error: "prompt is required" });
    }
    if (!agentId) {
      return res.status(400).json({ error: "agentId is required" });
    }
    if (!checkCwd(cwd, res)) return;
    const targetBranch = await resolveTargetBranch(cwd, req.body, res);
    if (targetBranch === undefined) return;
    const runId = await startRun({ prompt: prompt.trim(), agentId, decompose: !!decompose, cwd, targetBranch });
    res.json({ runId });
  });

  app.post("/api/run-workflow", async (req, res) => {
    const { prompt, workflowId, cwd, inputs } = req.body || {};
    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ error: "prompt is required" });
    }
    if (!workflowId) {
      return res.status(400).json({ error: "workflowId is required" });
    }
    if (!checkCwd(cwd, res)) return;
    const targetBranch = await resolveTargetBranch(cwd, req.body, res);
    if (targetBranch === undefined) return;
    try {
      const runId = await startWorkflowRun({ prompt: prompt.trim(), workflowId, cwd, targetBranch, inputs: inputs || {} });
      res.json({ runId });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  /** Stops a running run: kills the whole spawned CLI process tree and tells the run's own loop
   * to stop scheduling further steps. Returns as soon as the signals are out — the run flips to
   * `cancelled` on its own once it has finished unwinding. */
  app.post("/api/runs/:id/stop", runAction((req) => stopRun(req.params.id)));

  /** Deletes chat turns: one (`/chat/:turnId`) or all of them (`/chat`). See deleteChat. */
  const sendDeleteChat = runAction((req) => deleteChat(req.params.id, req.params.turnId || null), withRun);
  app.delete("/api/runs/:id/chat", sendDeleteChat);
  app.delete("/api/runs/:id/chat/:turnId", sendDeleteChat);

  /** Sends a follow-up message to a finished run's lead agent (chat). Returns once it's started;
   * the reply streams over the WebSocket like any task. */
  app.post("/api/runs/:id/continue", runAction((req) => continueRun(req.params.id, req.body?.message)));

  /** Re-runs a stopped/crashed/failed workflow run from its last checkpoint — steps that already
   * finished keep their recorded output and are not re-run. */
  app.post("/api/runs/:id/resume", runAction((req) => resumeRun(req.params.id)));
}
