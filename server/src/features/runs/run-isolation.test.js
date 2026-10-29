import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Running things must never change workflow config: a run executes against its own snapshot,
// and nothing on the run side writes workflows. This guards that statically, so a later change
// that reaches for the live workflow store from run code fails here instead of in someone's run.
const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, rel), "utf8");

test("run-side server code never writes workflows and only reads one to snapshot it", () => {
  for (const file of ["executor.js", "run-store.js", "cli-runners.js", "spawn-policy.js", "runs.routes.js"]) {
    const src = read(file);
    for (const fn of ["createWorkflow", "updateWorkflow", "deleteWorkflow", "saveWorkflows"]) {
      assert.ok(!new RegExp(`\\b${fn}\\b`).test(src), `${file} must not use ${fn}`);
    }
  }
  const executor = read("executor.js");
  const reads = executor.match(/\bgetWorkflow\(/g) || [];
  assert.equal(reads.length, 1, "executor.js reads the live workflow once: in startWorkflowRun, to snapshot it");
  assert.match(executor, /workflowNodes: structuredClone\(workflow\.nodes\)/, "the snapshot is a deep copy");
});

test("the Run tab never calls a workflow-changing API", () => {
  const runsUi = "../../../../client/src/features/runs";
  for (const file of [`${runsUi}/RunTab.jsx`, `${runsUi}/RunChatBox.jsx`, `${runsUi}/ReviewPanel.jsx`]) {
    const src = read(file);
    for (const call of ["createWorkflow", "updateWorkflow", "deleteWorkflow"]) {
      assert.ok(!src.includes(`api.${call}`), `${file} must not call api.${call}`);
    }
  }
});
