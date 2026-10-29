import { listAgents, createAgent, updateAgent, duplicateAgent, deleteAgent } from "./agents.store.js";

/** Agents CRUD. */
export function register(app) {
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
}
