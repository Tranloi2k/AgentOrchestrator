import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAccess, accessOptions, toolCeiling, claudeToolAccess } from "./access.js";

test("each level maps to the matching setting for every provider", () => {
  assert.deepEqual(normalizeAccess({ accessLevel: "read" }), {
    accessVersion: 2,
    accessLevel: "read",
    permissionMode: "default",
    codexSandbox: "read-only",
    codexNetworkAccess: false,
    agyMode: "plan",
  });
  const write = normalizeAccess({ accessLevel: "write" });
  assert.equal(write.permissionMode, "acceptEdits");
  assert.equal(write.codexSandbox, "workspace-write");
  assert.equal(write.agyMode, "accept-edits");
  const full = normalizeAccess({ accessLevel: "full" });
  assert.equal(full.permissionMode, "bypassPermissions");
  assert.equal(full.codexSandbox, "danger-full-access");
  assert.equal(full.agyMode, "skip");
});

test("provider settings may lower the level but never raise it", () => {
  assert.equal(normalizeAccess({ accessLevel: "full", permissionMode: "default" }).permissionMode, "default");
  assert.equal(normalizeAccess({ accessLevel: "write", permissionMode: "bypassPermissions" }).permissionMode, "acceptEdits");
  assert.equal(normalizeAccess({ accessLevel: "read", codexSandbox: "danger-full-access" }).codexSandbox, "read-only");
  assert.equal(normalizeAccess({ accessLevel: "write", agyMode: "skip" }).agyMode, "accept-edits");
  // network inside workspace-write only for a full-access agent that chose the narrower sandbox
  assert.equal(normalizeAccess({ accessLevel: "write", codexNetworkAccess: true }).codexNetworkAccess, false);
  assert.equal(normalizeAccess({ accessLevel: "full", codexSandbox: "workspace-write", codexNetworkAccess: true }).codexNetworkAccess, true);
  assert.deepEqual(accessOptions().write.permissionMode, ["plan", "default", "acceptEdits"]);
  assert.deepEqual(accessOptions().read.permissionMode, ["plan", "default"]);
});

test("agents saved before accessLevel get a level from their old fields", () => {
  assert.equal(normalizeAccess({ readOnly: true, permissionMode: "acceptEdits" }).accessLevel, "read");
  assert.equal(normalizeAccess({ provider: "claude", permissionMode: "bypassPermissions" }).accessLevel, "full");
  assert.equal(normalizeAccess({ provider: "claude", permissionMode: "acceptEdits" }).accessLevel, "write");
  const auto = normalizeAccess({ provider: "claude", permissionMode: "auto" });
  assert.deepEqual([auto.accessLevel, auto.permissionMode], ["full", "auto"], "behaviour kept: auto stays auto");
  assert.equal(normalizeAccess({ provider: "codex", codexSandbox: "danger-full-access" }).accessLevel, "full");
  assert.equal(normalizeAccess({ provider: "gemini", geminiApprovalMode: "auto_edit" }).agyMode, "accept-edits");
  assert.equal(normalizeAccess({ provider: "gemini", geminiApprovalMode: "yolo" }).accessLevel, "full");
});

test("tool ceiling: Claude allowlist minus Task, or what a non-Claude level implies", () => {
  assert.deepEqual(toolCeiling({ provider: "claude", allowedTools: ["Read", "Task", "Bash"] }), ["Read", "Bash"]);
  assert.deepEqual(toolCeiling({ provider: "gemini", accessLevel: "read" }), ["Read", "Grep", "Glob", "WebFetch", "WebSearch"]);
  assert.ok(!toolCeiling({ provider: "codex", accessLevel: "full" }).includes("Task"));
});

test("read-only Claude: plan from the old migration becomes default; write tools are always blocked", () => {
  const migrated = normalizeAccess({ accessLevel: "read", permissionMode: "plan" });
  assert.equal(migrated.permissionMode, "default", "plan stored before v2 was the old default, not a choice");
  assert.equal(normalizeAccess({ accessVersion: 2, accessLevel: "read", permissionMode: "plan" }).permissionMode, "plan", "a v2 choice is kept");

  const access = claudeToolAccess({ accessLevel: "read", toolPolicy: "allowlist", allowedTools: ["Read", "Edit", "Bash", "Grep"] });
  assert.deepEqual(access.allowed, ["Read", "Grep"]);
  for (const t of ["Edit", "Write", "NotebookEdit", "Bash"]) assert.ok(access.denied.includes(t), t);

  const write = claudeToolAccess({ accessLevel: "write", toolPolicy: "allowlist", allowedTools: ["Read", "Edit"] });
  assert.deepEqual(write.allowed, ["Read", "Edit"]);
  assert.ok(!write.denied.includes("Edit"));
  assert.deepEqual(claudeToolAccess({ permissionMode: "plan", allowedTools: [] }), { allowed: [], denied: [] }, "internal planner: no flags");
});
