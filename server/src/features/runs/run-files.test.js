import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRunFiles, writeRunFile, removeRunFile, migrateLegacyRuns } from "./run-files.js";

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "ao-runs-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const byId = (runs) => [...runs].sort((a, b) => a.id.localeCompare(b.id));

test("writes, loads and removes one file per run", () => {
  withTempDir((root) => {
    const dir = path.join(root, "runs");
    assert.deepEqual(loadRunFiles(dir), []); // creates the directory
    writeRunFile(dir, { id: "a", tasks: [] });
    writeRunFile(dir, { id: "b", tasks: [] });
    assert.deepEqual(byId(loadRunFiles(dir)).map((r) => r.id), ["a", "b"]);

    removeRunFile(dir, "a");
    removeRunFile(dir, "missing");
    assert.deepEqual(loadRunFiles(dir).map((r) => r.id), ["b"]);
  });
});

test("one damaged run file does not lose the others", () => {
  withTempDir((dir) => {
    writeRunFile(dir, { id: "good" });
    writeFileSync(path.join(dir, "bad.json"), "{", "utf-8");
    const original = console.error;
    console.error = () => {};
    try {
      assert.deepEqual(loadRunFiles(dir).map((r) => r.id), ["good"]);
    } finally {
      console.error = original;
    }
    assert.ok(readdirSync(dir).some((name) => name.startsWith("bad.json.corrupt-")));
  });
});

test("migrates the legacy runs.json into per-run files and keeps it as a backup", () => {
  withTempDir((root) => {
    const legacy = path.join(root, "runs.json");
    const dir = path.join(root, "runs");
    writeFileSync(legacy, JSON.stringify([{ id: "a" }, { id: "b" }], null, 2), "utf-8");

    assert.equal(migrateLegacyRuns(legacy, dir), 2);
    assert.deepEqual(byId(loadRunFiles(dir)).map((r) => r.id), ["a", "b"]);
    assert.ok(!existsSync(legacy));
    assert.ok(existsSync(`${legacy}.migrated`));

    assert.equal(migrateLegacyRuns(legacy, dir), 0, "nothing left to migrate");
  });
});
