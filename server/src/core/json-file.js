/**
 * Reading and writing the server's JSON data files without ever losing them.
 *
 * Writes go to a temp file that is then renamed over the target, so a crash mid-write leaves the
 * previous version intact instead of a truncated file. A file that exists but won't parse is moved
 * aside as <file>.corrupt-<time> rather than treated as empty — otherwise the next save would
 * overwrite it with the fallback and the data would be gone without a trace.
 */
import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";

// Windows refuses the rename while something (antivirus, an editor) briefly holds the target.
const RENAME_RETRIES = 5;
const RENAME_RETRY_MS = 20;
const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES"]);

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function saveJson(file, data, { pretty = true } = {}) {
  const tmp = `${file}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, pretty ? 2 : undefined), "utf-8");
    for (let attempt = 0; ; attempt++) {
      try {
        renameSync(tmp, file);
        return;
      } catch (err) {
        if (!RETRYABLE.has(err.code) || attempt >= RENAME_RETRIES) throw err;
        sleepSync(RENAME_RETRY_MS);
      }
    }
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

function loadJson(file, fallback) {
  let text;
  try {
    text = readFileSync(file, "utf-8");
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    const backup = `${file}.corrupt-${Date.now()}`;
    renameSync(file, backup);
    console.error(`[orchestrator] ${file} không đọc được (${err.message}) — đã giữ lại bản cũ ở ${backup}.`);
    return fallback;
  }
}

export { saveJson, loadJson };
