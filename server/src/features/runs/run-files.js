/**
 * Run history on disk: one <runId>.json per run inside a directory, so saving a run that is
 * streaming logs rewrites only that run instead of the whole history, and a damaged file costs
 * one run rather than all of them. Plain I/O — run-store.js decides what to save and when.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { loadJson, saveJson } from "../../core/json-file.js";

const runFile = (dir, id) => path.join(dir, `${id}.json`);

function loadRunFiles(dir) {
  mkdirSync(dir, { recursive: true });
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => loadJson(path.join(dir, name), null))
    .filter((run) => run && run.id);
}

// Compact: these are runtime files nobody edits by hand, and logs make them large.
function writeRunFile(dir, run) {
  saveJson(runFile(dir, run.id), run, { pretty: false });
}

function removeRunFile(dir, id) {
  rmSync(runFile(dir, id), { force: true });
}

/** Splits the old single runs.json into per-run files, then keeps it as <file>.migrated. */
function migrateLegacyRuns(legacyFile, dir) {
  if (!existsSync(legacyFile)) return 0;
  mkdirSync(dir, { recursive: true });
  const runs = loadJson(legacyFile, []);
  for (const run of runs) {
    if (run?.id) writeRunFile(dir, run);
  }
  if (existsSync(legacyFile)) renameSync(legacyFile, `${legacyFile}.migrated`);
  return runs.length;
}

export { loadRunFiles, writeRunFile, removeRunFile, migrateLegacyRuns };
