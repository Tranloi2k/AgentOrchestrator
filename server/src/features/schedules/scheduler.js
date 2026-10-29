/**
 * Cron triggers for workflows. Once a minute (on the minute, server local time) every enabled
 * schedule of every workflow is checked; a matching one starts a run with the schedule's own
 * request, inputs, folder and target branch, exactly as if it had been started from the Run tab.
 *
 * A schedule whose previous run is still going is skipped for that minute rather than stacked,
 * so a slow daily job can't pile up. Minutes missed while the server was down are not caught up.
 * What happened last (run started, skipped, error) is kept in memory for the editor to show.
 */
import { listWorkflows } from "../workflows/workflows.store.js";
import { listRuns } from "../runs/run-store.js";
import { startWorkflowRun } from "../runs/executor.js";
import { prepareTargetBranch } from "../workspace/workspace.js";
import { parseCron, cronMatches, nextRuns } from "./cron.js";
import { isPathAllowed } from "../../core/security.js";
import { DEFAULT_CWD } from "../../core/config.js";

/** scheduleId -> { lastFiredAt, lastRunId, lastSkipped, lastError } */
const status = new Map();
const fired = new Set(); // "<scheduleId>@<minute>" — a minute fires a schedule once at most

function minuteKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()} ${date.getHours()}:${date.getMinutes()}`;
}

async function fire(workflow, schedule, now) {
  const record = { ...(status.get(schedule.id) || {}), lastFiredAt: now.getTime(), lastError: null, lastSkipped: null };
  status.set(schedule.id, record);
  const busy = listRuns().find((r) => r.status === "running" && r.trigger?.scheduleId === schedule.id);
  if (busy) {
    record.lastSkipped = `Run trước (${busy.id}) vẫn đang chạy — bỏ qua lần này.`;
    return;
  }
  try {
    const cwd = schedule.cwd || DEFAULT_CWD;
    if (!isPathAllowed(cwd)) throw new Error("Thư mục nằm ngoài các thư mục được phép (ALLOWED_ROOTS).");
    const targetBranch = await prepareTargetBranch(cwd, { branch: schedule.targetBranch || null });
    record.lastRunId = await startWorkflowRun({
      prompt: schedule.prompt,
      workflowId: workflow.id,
      cwd,
      targetBranch,
      inputs: schedule.inputs,
      trigger: { type: "schedule", scheduleId: schedule.id, cron: schedule.cron },
    });
  } catch (err) {
    record.lastError = err.message;
    console.error(`[scheduler] ${workflow.name} (${schedule.cron}): ${err.message}`);
  }
}

export function tick(now = new Date()) {
  const key = minuteKey(now);
  for (const workflow of listWorkflows()) {
    for (const schedule of workflow.schedules || []) {
      if (!schedule.enabled) continue;
      let cron;
      try {
        cron = parseCron(schedule.cron);
      } catch {
        continue; // saved workflows are validated; this only guards hand-edited files
      }
      if (!cronMatches(cron, now) || fired.has(`${schedule.id}@${key}`)) continue;
      fired.add(`${schedule.id}@${key}`);
      fire(workflow, schedule, now);
    }
  }
  if (fired.size > 5000) fired.clear();
}

export function startScheduler() {
  const delay = 60_000 - (Date.now() % 60_000) + 500; // just after the next minute begins
  setTimeout(() => {
    tick();
    setInterval(() => tick(), 60_000).unref();
  }, delay).unref();
}

/** For the editor: what each schedule did last, and when it fires next. */
export function scheduleStatus() {
  const out = {};
  for (const workflow of listWorkflows()) {
    for (const schedule of workflow.schedules || []) {
      let next = [];
      try {
        next = schedule.enabled ? nextRuns(schedule.cron, 1).map((d) => d.getTime()) : [];
      } catch {
        /* invalid cron: no next run */
      }
      out[schedule.id] = { ...(status.get(schedule.id) || {}), nextAt: next[0] || null };
    }
  }
  return out;
}
