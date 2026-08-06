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
  CODEX_SANDBOX_MODES,
  CODEX_MODELS,
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
  deleteRun,
  clearRuns,
  startRun,
  startWorkflowRun,
  stopRun,
  resumeRun,
  askAgent,
  subscribe,
  DEFAULT_CWD,
} from "./orchestrator.js";

const PORT = process.env.PORT || 5175;

const app = express();
app.use(cors());
app.use(express.json());

/** meta: model list, known tools, default working dir */
app.get("/api/meta", (req, res) => {
  res.json({
    models: MODELS,
    tools: KNOWN_TOOLS,
    providers: PROVIDERS,
    providerAvailability: PROVIDER_AVAILABILITY,
    codexSandboxModes: CODEX_SANDBOX_MODES,
    codexModels: CODEX_MODELS,
    defaultCwd: DEFAULT_CWD,
  });
});

/** Read-only directory browser so the UI can offer a "Browse..." picker for
 * the working-directory field without relying on a native OS file dialog. */
app.get("/api/browse-dirs", (req, res) => {
  let target = req.query.path ? String(req.query.path) : DEFAULT_CWD;
  target = path.resolve(target);

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
  res.json({ path: target, parent: parent === target ? null : parent, dirs });
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

app.post("/api/workflows", (req, res) => {
  res.json({ workflow: createWorkflow(req.body || {}) });
});

app.put("/api/workflows/:id", (req, res) => {
  const workflow = updateWorkflow(req.params.id, req.body || {});
  if (!workflow) return res.status(404).json({ error: "not found" });
  res.json({ workflow });
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

app.get("/api/runs/:id", (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "not found" });
  res.json({ run });
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

app.post("/api/run", async (req, res) => {
  const { prompt, agentId, decompose, cwd } = req.body || {};
  if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
    return res.status(400).json({ error: "prompt is required" });
  }
  if (!agentId) {
    return res.status(400).json({ error: "agentId is required" });
  }
  const runId = await startRun({ prompt: prompt.trim(), agentId, decompose: !!decompose, cwd });
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
  try {
    const runId = await startWorkflowRun({ prompt: prompt.trim(), workflowId, cwd });
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
 * (the caller's tool call blocks until this resolves). Not meant to be called from the UI. */
app.post("/api/internal/ask-agent", async (req, res) => {
  const { runId, workflowId, callerNodeId, targetNodeId, question, cwd, depth } = req.body || {};
  if (!runId || !workflowId || !callerNodeId || !targetNodeId || !question) {
    return res.status(400).json({ error: "thiếu runId/workflowId/callerNodeId/targetNodeId/question" });
  }
  try {
    const answer = await askAgent({ runId, workflowId, callerNodeId, targetNodeId, question, cwd, depth: depth || 0 });
    res.json({ answer });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  const unsubscribe = subscribe((event) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(event));
    }
  });
  ws.on("close", unsubscribe);
});

server.listen(PORT, () => {
  console.log(`[orchestrator] server listening on http://localhost:${PORT}`);
  console.log(`[orchestrator] default target dir: ${DEFAULT_CWD}`);
});
