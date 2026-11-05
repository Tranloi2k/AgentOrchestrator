/**
 * The message the review commit (and the merge on Accept) carries: what the agents actually
 * changed, in their own words, instead of "orchestrator: accept ao/review-…". Each agent that
 * may change files ends its answer with a `COMMIT:` line (commitInstruction); the run's message
 * is the lead's line as the subject (the coordinator, or the last node to finish) with the other
 * agents' lines as bullets. Pure, so it can be unit-tested.
 */

export const commitInstruction = () =>
  "Nếu bạn đã sửa file trong lượt này, dòng CUỐI CÙNG của câu trả lời phải là:\n" +
  "COMMIT: <tóm tắt thay đổi bằng tiếng Anh, dạng mệnh lệnh, tối đa 72 ký tự, vd \"Fix reserve off-by-one, WELCOME5 discount, tax-after-discount\">\n" +
  "Người điều phối/tổng hợp viết một dòng COMMIT cho toàn bộ thay đổi của cả nhóm. Không sửa file nào thì không viết dòng này.";

const COMMIT_RE = /^[\s>*_`-]*COMMIT\s*:[\s*_`]*(.+?)[\s*_`]*$/gim;

/** The last `COMMIT:` line of an answer, cleaned up, or null. */
export function extractCommitLine(text) {
  const last = [...String(text || "").matchAll(COMMIT_RE)].at(-1)?.[1];
  const line = String(last || "")
    .replace(/^["'<]+|["'>]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return line ? line.slice(0, 120) : null;
}

const LEAD_KINDS = ["workflow-node", "followup", "agent", "single"];

/** "Update pricing.js, inventory.js (+2 files)" when no agent wrote a COMMIT line. */
function fallbackSubject(files) {
  const names = files.map((f) => String(f.path || "").split("/").pop()).filter(Boolean);
  if (!names.length) return "Apply agent changes";
  const shown = names.slice(0, 3).join(", ");
  return names.length > 3 ? `Update ${shown} (+${names.length - 3} files)` : `Update ${shown}`;
}

/**
 * The commit message for a run's review: subject from the latest lead task's COMMIT line (else
 * the latest anyone wrote, else the changed files), body with every other distinct line, and the
 * run id so the commit can be traced back.
 */
export function runCommitMessage(run, files = []) {
  const lines = [];
  for (const task of run.tasks || []) {
    if (task.status !== "done") continue;
    const line = extractCommitLine(task.resultText);
    if (line) lines.push({ line, lead: LEAD_KINDS.includes(task.kind) });
  }
  const subject = lines.filter((l) => l.lead).at(-1)?.line || lines.at(-1)?.line || fallbackSubject(files);
  const details = [...new Set(lines.map((l) => l.line))].filter((l) => l !== subject);
  return [subject, details.length ? details.map((l) => `- ${l}`).join("\n") : null, `Run: ${run.id}`].filter(Boolean).join("\n\n");
}
