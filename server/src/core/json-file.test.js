import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadJson, saveJson } from "./json-file.js";

function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "ao-json-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("saveJson writes the file and leaves no temp file behind", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "data.json");
    saveJson(file, [{ id: "a" }]);
    saveJson(file, [{ id: "b" }]);
    assert.deepEqual(loadJson(file, null), [{ id: "b" }]);
    assert.deepEqual(readdirSync(dir), ["data.json"]);
  });
});

test("saveJson writes compact JSON when asked", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "data.json");
    saveJson(file, { a: 1, b: [2] }, { pretty: false });
    assert.equal(readFileSync(file, "utf-8"), '{"a":1,"b":[2]}');
  });
});

test("loadJson returns the fallback for a missing file", () => {
  withTempDir((dir) => {
    assert.deepEqual(loadJson(path.join(dir, "missing.json"), []), []);
  });
});

test("loadJson moves an unreadable file aside instead of letting it be overwritten", () => {
  withTempDir((dir) => {
    const file = path.join(dir, "data.json");
    writeFileSync(file, '[{"id": "a"', "utf-8");
    const original = console.error;
    console.error = () => {};
    try {
      assert.deepEqual(loadJson(file, []), []);
    } finally {
      console.error = original;
    }
    const backups = readdirSync(dir).filter((name) => name.startsWith("data.json.corrupt-"));
    assert.equal(backups.length, 1);
    assert.equal(readFileSync(path.join(dir, backups[0]), "utf-8"), '[{"id": "a"');
    assert.ok(!readdirSync(dir).includes("data.json"));
  });
});
