import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isAllowedHostHeader, isAllowedOrigin, isPathAllowed, parseAllowedRoots } from "./security.js";

test("only loopback Host headers are accepted", () => {
  assert.equal(isAllowedHostHeader("localhost:5175"), true);
  assert.equal(isAllowedHostHeader("127.0.0.1:5175"), true);
  assert.equal(isAllowedHostHeader("[::1]:5175"), true);
  assert.equal(isAllowedHostHeader("LOCALHOST"), true);
  assert.equal(isAllowedHostHeader("evil.example"), false);
  assert.equal(isAllowedHostHeader("192.168.1.10:5175"), false);
  assert.equal(isAllowedHostHeader(undefined), false);
});

test("Origin must be on the allowlist; missing Origin is a non-browser client", () => {
  const allowed = ["http://localhost:5173"];
  assert.equal(isAllowedOrigin(undefined, allowed), true);
  assert.equal(isAllowedOrigin("http://localhost:5173", allowed), true);
  assert.equal(isAllowedOrigin("http://localhost:5173/", allowed), true);
  assert.equal(isAllowedOrigin("https://evil.example", allowed), false);
  assert.equal(isAllowedOrigin("null", allowed), false);
});

test("isPathAllowed keeps paths inside the configured roots", () => {
  const base = mkdtempSync(path.join(tmpdir(), "ao-roots-"));
  try {
    const root = path.join(base, "root");
    const sibling = path.join(base, "root-other");
    mkdirSync(path.join(root, "child"), { recursive: true });
    mkdirSync(sibling);
    const roots = parseAllowedRoots(root);

    assert.equal(isPathAllowed(root, roots), true);
    assert.equal(isPathAllowed(path.join(root, "child"), roots), true);
    assert.equal(isPathAllowed(path.join(root, "child", ".."), roots), true);
    assert.equal(isPathAllowed(path.join(root, ".."), roots), false);
    assert.equal(isPathAllowed(sibling, roots), false);
    assert.equal(isPathAllowed(base, []), true, "no roots configured = unrestricted");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
