import test from "node:test";
import assert from "node:assert/strict";
import { extractCommitLine, runCommitMessage } from "./commit-message.js";

test("extractCommitLine: the last COMMIT line, without markdown or quotes", () => {
  assert.equal(extractCommitLine("Done.\n\nCOMMIT: Fix reserve off-by-one"), "Fix reserve off-by-one");
  assert.equal(extractCommitLine("**COMMIT:** `Fix tax-after-discount`"), "Fix tax-after-discount");
  assert.equal(extractCommitLine('COMMIT: "first"\n...\nCOMMIT: <second>'), "second");
  assert.equal(extractCommitLine("no line here"), null);
  assert.equal(extractCommitLine(null), null);
});

test("runCommitMessage: the lead's line is the subject, the other agents' lines the body", () => {
  const run = {
    id: "r1",
    tasks: [
      { kind: "agent-spawn", status: "done", resultText: "Patched.\nCOMMIT: Fix reserve off-by-one" },
      { kind: "agent-spawn", status: "done", resultText: "COMMIT: Fix WELCOME5 discount" },
      { kind: "agent-spawn", status: "error", resultText: "COMMIT: Never landed" },
      { kind: "workflow-node", status: "done", resultText: "Report…\nCOMMIT: Fix reserve off-by-one, WELCOME5 discount, tax-after-discount" },
    ],
  };
  assert.equal(
    runCommitMessage(run, []),
    "Fix reserve off-by-one, WELCOME5 discount, tax-after-discount\n\n- Fix reserve off-by-one\n- Fix WELCOME5 discount\n\nRun: r1"
  );
});

test("runCommitMessage: without any COMMIT line, names the changed files", () => {
  const files = ["src/pricing.js", "src/inventory.js", "a.js", "b.js"].map((path) => ({ path }));
  assert.equal(runCommitMessage({ id: "r2", tasks: [] }, files), "Update pricing.js, inventory.js, a.js (+1 files)\n\nRun: r2");
  assert.equal(runCommitMessage({ id: "r3", tasks: [] }, []), "Apply agent changes\n\nRun: r3");
});
