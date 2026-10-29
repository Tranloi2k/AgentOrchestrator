import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import http from "node:http";
import { readdirSync } from "node:fs";
import path from "node:path";
import {
  MODELS,
  KNOWN_TOOLS,
  PROVIDERS,
  PROVIDER_AVAILABILITY,
  CODEX_MODELS,
  AGY_MODELS,
  listAgents,
  createAgent,
  updateAgent,
  deleteAgent,
  duplicateAgent,
  listWorkflows,
  createWorkflow,
  updateWorkflow,
  deleteWorkflow,
  listSkills,
  createSkill,
  updateSkill,
  deleteSkill,
  listPlugins,
  createPlugin,
  updatePlugin,
  deletePlugin,
  listRuns,
  getRun,
  getUsageSummary,
  acceptRunReview,
  declineRunReview,
  deleteRun,
  clearRuns,
  startRun,
  startWorkflowRun,
  stopRun,
  resumeRun,
  continueRun,
  deleteChat,
  askAgent,
  spawnAgent,
  subscribe,
  DEFAULT_CWD,
} from "./orchestrator.js";

import { ACCESS_LEVELS, accessOptions } from "./access.js";
import { listBranches, prepareTargetBranch } from "./workspace.js";
import {
  HOST,
  ALLOWED_ORIGINS,
  ALLOWED_ROOTS,
  isLoopbackHost,
  isPathAllowed,
  requestGuard,
  requireInternalToken,
  verifyWsClient,
} from "./security.js";

const PORT = process.env.PORT || 5175;

const app = express();
app.use(requestGuard);
app.use(cors({ origin: ALLOWED_ORIGINS }));
app.use(express.json());

/** Rejects a run's `cwd` outside ALLOWED_ROOTS (no-op when ALLOWED_ROOTS is unset). */
function checkCwd(cwd, res) {
  if (cwd && !isPathAllowed(String(cwd))) {
    res.status(403).json({ error: "cwd nằm ngoài các thư mục được phép (ALLOWED_ROOTS)" });
    return false;
  }
  return true;
}

/** meta: model list, known tools, default working dir */
app.get("/api/meta", (req, res) => {
  res.json({
    models: MODELS,
    tools: KNOWN_TOOLS,
    providers: PROVIDERS,
    providerAvailability: PROVIDER_AVAILABILITY,
    codexModels: CODEX_MODELS,
    geminiModels: AGY_MODELS,
    accessLevels: ACCESS_LEVELS,
    accessOptions: accessOptions(),
    defaultCwd: DEFAULT_CWD,
  });
});

/** Read-only directory browser so the UI can offer a "Browse..." picker for
 * the working-directory field without relying on a native OS file dialog. */
app.get("/api/browse-dirs", (req, res) => {
  const fallback = isPathAllowed(DEFAULT_CWD) ? DEFAULT_CWD : ALLOWED_ROOTS[0];
  let target = req.query.path ? String(req.query.path) : fallback;
  target = path.resolve(target);
  if (!isPathAllowed(target)) {
    return res.status(403).json({ error: "Thư mục nằm ngoài các thư mục được phép (ALLOWED_ROOTS)" });
  }

  let entries;
  try {
    entries = readdirSync(target, { withFileTypes: true });
  } catch (err) {
    return res.status(400).json({ error: `Không đọc được thư mục: ${err.message}` });
  }

  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => ({ name: e.name, path: path.join(target, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const parent = path.dirname(target);
  const hasParent = parent !== target && isPathAllowed(parent);
  res.json({ path: target, parent: hasParent ? parent : null, dirs });
});

/** ---- agents CRUD ---- */
app.get("/api/agents", (req, res) => {
  res.json({ agents: listAgents() });
});

app.post("/api/agents", (req, res) => {
  res.json({ agent: createAgent(req.body || {}) });
});

app.post("/api/agents/:id/duplicate", (req, res) => {
  const agent = duplicateAgent(req.params.id);
  if (!agent) return res.status(404).json({ error: "not found" });
  res.json({ agent });
});

app.put("/api/agents/:id", (req, res) => {
  const agent = updateAgent(req.params.id, req.body || {});
  if (!agent) return res.status(404).json({ error: "not found" });
  res.json({ agent });
});

app.delete("/api/agents/:id", (req, res) => {
  try {
    const ok = deleteAgent(req.params.id);
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

/** ---- skills CRUD ---- */
app.get("/api/skills", (req, res) => {
  res.json({ skills: listSkills() });
});

app.post("/api/skills", (req, res) => {
  res.json({ skill: createSkill(req.body || {}) });
});

app.put("/api/skills/:id", (req, res) => {
  const skill = updateSkill(req.params.id, req.body || {});
  if (!skill) return res.status(404).json({ error: "not found" });
  res.json({ skill });
});

app.delete("/api/skills/:id", (req, res) => {
  try {
    const ok = deleteSkill(req.params.id);
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

/** ---- plugins CRUD (real Claude Code plugins, e.g. github.com/DietrichGebert/ponytail) ---- */
app.get("/api/plugins", (req, res) => {
  res.json({ plugins: listPlugins() });
});

app.post("/api/plugins", (req, res) => {
  try {
    res.json({ plugin: createPlugin(req.body || {}) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put("/api/plugins/:id", (req, res) => {
  const plugin = updatePlugin(req.params.id, req.body || {});
  if (!plugin) return res.status(404).json({ error: "not found" });
  res.json({ plugin });
});

app.delete("/api/plugins/:id", (req, res) => {
  const ok = deletePlugin(req.params.id);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

/** ---- workflows CRUD ---- */
app.get("/api/workflows", (req, res) => {
  res.json({ workflows: listWorkflows() });
});

/** A workflow that fails validation comes back as 400 with `errors: [{ code, params }]` —
 * the full list, so the editor can show every problem at once. */
function sendWorkflowError(res, err) {
  if (err.errors) return res.status(400).json({ error: err.message, errors: err.errors });
  res.status(400).json({ error: err.message });
}

app.post("/api/workflows", (req, res) => {
  try {
    res.json({ workflow: createWorkflow(req.body || {}) });
  } catch (err) {
    sendWorkflowError(res, err);
  }
});

app.put("/api/workflows/:id", (req, res) => {
  try {
    const workflow = updateWorkflow(req.params.id, req.body || {});
    if (!workflow) return res.status(404).json({ error: "not found" });
    res.json({ workflow });
  } catch (err) {
    sendWorkflowError(res, err);
  }
});

app.delete("/api/workflows/:id", (req, res) => {
  const ok = deleteWorkflow(req.params.id);
  if (!ok) return res.status(404).json({ error: "not found" });
  res.json({ ok: true });
});

/** ---- runs ---- */
app.get("/api/runs", (req, res) => {
  res.json({ runs: listRuns() });
});

/** Token/cost usage rolled up from run history — per-provider (claude vs codex) and per-agent
 * totals. See getUsageSummary() in orchestrator.js. */
app.get("/api/usage", (req, res) => {
  res.json(getUsageSummary());
});

app.get("/api/runs/:id", (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "not found" });
  res.json({ run });
});

app.post("/api/runs/:id/review/accept", async (req, res) => {
  try {
    const ok = await acceptRunReview(req.params.id);
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json({ run: getRun(req.params.id) });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

app.post("/api/runs/:id/review/decline", async (req, res) => {
  try {
    const ok = await declineRunReview(req.params.id);
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json({ run: getRun(req.params.id) });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

app.delete("/api/runs/:id", (req, res) => {
  try {
    const ok = deleteRun(req.params.id);
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

app.delete("/api/runs", (req, res) => {
  res.json(clearRuns());
});

/** Local branches of the git repo containing `cwd` (target-branch picker); `repo: null` if not git. */
app.get("/api/git/branches", async (req, res) => {
  const cwd = String(req.query.cwd || DEFAULT_CWD);
  if (!checkCwd(cwd, res)) return;
  res.json({ repo: await listBranches(cwd) });
});

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
  const { prompt, workflowId, cwd } = req.body || {};
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
    const runId = await startWorkflowRun({ prompt: prompt.trim(), workflowId, cwd, targetBranch });
    res.json({ runId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/** Stops a running run: kills the whole spawned CLI process tree and tells the run's own loop
 * to stop scheduling further steps. Returns as soon as the signals are out — the run flips to
 * `cancelled` on its own once it has finished unwinding. */
app.post("/api/runs/:id/stop", (req, res) => {
  try {
    const ok = stopRun(req.params.id);
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

/** Re-runs a stopped/crashed/failed workflow run from its last checkpoint — steps that already
 * finished keep their recorded output and are not re-run. */
/** Sends a follow-up message to a finished run's lead agent (chat). Returns once it's started;
 * the reply streams over the WebSocket like any task. */
/** Deletes chat turns: one (`/chat/:turnId`) or all of them (`/chat`). See deleteChat. */
function sendDeleteChat(req, res) {
  try {
    const ok = deleteChat(req.params.id, req.params.turnId || null);
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json({ run: getRun(req.params.id) });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
}
app.delete("/api/runs/:id/chat", sendDeleteChat);
app.delete("/api/runs/:id/chat/:turnId", sendDeleteChat);

app.post("/api/runs/:id/continue", (req, res) => {
  try {
    const ok = continueRun(req.params.id, req.body?.message);
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

app.post("/api/runs/:id/resume", (req, res) => {
  try {
    const ok = resumeRun(req.params.id);
    if (!ok) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

/** Internal-only: hit by mcp-bridge.js (a side-process of a running agent) when that agent
 * calls its `ask_agent` MCP tool — this is what makes agent-to-agent calls synchronous
 * (the caller's tool call blocks until this resolves). Not meant to be called from the UI —
 * requires the per-start token that only the bridge processes receive. */
app.post("/api/internal/ask-agent", requireInternalToken, async (req, res) => {
  const { runId, workflowId, callerNodeId, targetNodeId, question, workItemId, parentWorkItemId, cwd, depth } = req.body || {};
  if (!runId || !workflowId || !callerNodeId || !targetNodeId || !question || !workItemId) {
    return res.status(400).json({ error: "thiếu runId/workflowId/callerNodeId/targetNodeId/question/workItemId" });
  }
  try {
    const outcome = await askAgent({
      runId,
      workflowId,
      callerNodeId,
      targetNodeId,
      question,
      workItemId,
      parentWorkItemId,
      cwd,
      depth: depth || 0,
    });
    res.json(outcome);
  } catch (err) {
    res.status(409).json({ error: err.message });
  }
});

/** Internal-only: the bridge's `spawn_agent` tool. The caller is identified by its bridge session
 * id alone; policy, depth and cwd come from the server's own record of that session. */
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

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws", verifyClient: verifyWsClient });

wss.on("connection", (ws) => {
  const unsubscribe = subscribe((event) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(event));
    }
  });
  ws.on("close", unsubscribe);
});

server.listen(PORT, HOST, () => {
  console.log(`[orchestrator] server listening on http://${HOST}:${PORT}`);
  console.log(`[orchestrator] default target dir: ${DEFAULT_CWD}`);
  console.log(`[orchestrator] allowed origins: ${ALLOWED_ORIGINS.join(", ")}`);
  if (ALLOWED_ROOTS.length) console.log(`[orchestrator] allowed roots: ${ALLOWED_ROOTS.join(", ")}`);
  if (!isLoopbackHost(HOST)) {
    console.warn(`[orchestrator] WARNING: HOST=${HOST} is not loopback — the port is open to other machines (requests whose Host isn't localhost are still refused).`);
  }
});
