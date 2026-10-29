import { listWorkflows, createWorkflow, updateWorkflow, deleteWorkflow } from "./workflows.store.js";

/** A workflow that fails validation comes back as 400 with `errors: [{ code, params }]` —
 * the full list, so the editor can show every problem at once. */
function sendWorkflowError(res, err) {
  if (err.errors) return res.status(400).json({ error: err.message, errors: err.errors });
  res.status(400).json({ error: err.message });
}

/** Workflows CRUD. */
export function register(app) {
  app.get("/api/workflows", (req, res) => {
    res.json({ workflows: listWorkflows() });
  });

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
}
