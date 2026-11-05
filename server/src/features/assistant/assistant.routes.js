import { askAssistant, AssistantRequestError } from "./assistant.js";

/** Editor assistant: one chat turn for the Workflow / Agent form. */
export function register(app) {
  app.post("/api/assistant", async (req, res) => {
    try {
      res.json(await askAssistant(req.body || {}));
    } catch (err) {
      res.status(err instanceof AssistantRequestError ? err.status : 500).json({ error: err.message });
    }
  });
}
