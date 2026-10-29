import { nextRuns } from "./cron.js";
import { scheduleStatus } from "./scheduler.js";

/** Cron schedules: a preview for the editor, and what each schedule did last. */
export function register(app) {
  /** Is the expression valid, and when would it fire next. */
  app.post("/api/cron/preview", (req, res) => {
    try {
      res.json({ ok: true, next: nextRuns(String(req.body?.cron || ""), 3).map((d) => d.getTime()) });
    } catch (err) {
      res.json({ ok: false, error: err.message });
    }
  });

  /** What each workflow schedule did last and when it fires next. */
  app.get("/api/schedules/status", (req, res) => {
    res.json({ status: scheduleStatus() });
  });
}
