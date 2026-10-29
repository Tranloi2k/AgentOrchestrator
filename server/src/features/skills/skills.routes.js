import { listSkills, createSkill, updateSkill, deleteSkill } from "./skills.store.js";

/** Skills CRUD. */
export function register(app) {
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
}
