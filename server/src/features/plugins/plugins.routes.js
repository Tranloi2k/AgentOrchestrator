import { listPlugins, createPlugin, updatePlugin, deletePlugin } from "./plugins.store.js";

/** Plugins CRUD (real Claude Code plugins, e.g. github.com/DietrichGebert/ponytail). */
export function register(app) {
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
}
