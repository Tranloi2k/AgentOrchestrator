import test from "node:test";
import assert from "node:assert/strict";
import { classifyAgentFailure, finishDelegation, parseQuotaReset, reserveDelegation } from "./delegation-policy.js";

const base = (overrides = {}) => ({
  callerNodeId: "pm",
  targetNodeId: "fe-1",
  workItemId: "feature",
  question: "Implement the feature",
  assignmentId: Math.random().toString(),
  ...overrides,
});

test("one logical work item cannot be assigned to two agents", () => {
  const run = {};
  const first = reserveDelegation(run, base());
  finishDelegation(first, { ok: true });
  assert.throws(
    () => reserveDelegation(run, base({ targetNodeId: "fe-2" })),
    /Chỉ được đổi agent/
  );
});

test("a second concurrent claim is rejected before either agent can duplicate the work", () => {
  const run = {};
  reserveDelegation(run, base());
  assert.throws(
    () => reserveDelegation(run, base({ targetNodeId: "fe-2" })),
    /đang được agent fe-1 thực hiện/
  );
});

test("same agent may continue the same logical work item", () => {
  const run = {};
  const first = reserveDelegation(run, base());
  finishDelegation(first, { ok: true });
  assert.doesNotThrow(() => reserveDelegation(run, base({ question: "Fix the review findings" })));
});

test("another agent may take over only after quota/provider failure", () => {
  for (const failureReason of ["quota", "provider_unavailable"]) {
    const run = {};
    const first = reserveDelegation(run, base());
    finishDelegation(first, { ok: false, failureReason });
    assert.doesNotThrow(() => reserveDelegation(run, base({ targetNodeId: "fe-2" })));
  }

  const run = {};
  const first = reserveDelegation(run, base());
  finishDelegation(first, { ok: false, failureReason: "agent_error" });
  assert.throws(() => reserveDelegation(run, base({ targetNodeId: "fe-2" })), /Chỉ được đổi agent/);
});

test("new work requires an explicit parent and duplicate content is rejected", () => {
  const run = {};
  const first = reserveDelegation(run, base());
  finishDelegation(first, { ok: true });

  assert.throws(
    () => reserveDelegation(run, base({ workItemId: "second", targetNodeId: "fe-2", question: "Another task" })),
    /parentWorkItemId/
  );
  assert.doesNotThrow(() =>
    reserveDelegation(run, base({ workItemId: "subtask-a", parentWorkItemId: "feature", targetNodeId: "fe-2", question: "Implement only the table UI" }))
  );
  assert.throws(
    () => reserveDelegation(run, base({ workItemId: "renamed-copy", parentWorkItemId: "feature", targetNodeId: "fe-2" })),
    /không được đổi mã/
  );
});

test("failure classifier only unlocks failover for quota or unavailable provider", () => {
  assert.equal(classifyAgentFailure({ exitCode: 1, stderr: "You've hit your usage limit" }), "quota");
  assert.equal(classifyAgentFailure({ exitCode: 1, stderr: "HTTP 429 too many requests" }), "quota");
  assert.equal(classifyAgentFailure({ exitCode: 1, stderr: "[API Error: RESOURCE_EXHAUSTED]" }), "quota");
  assert.equal(classifyAgentFailure({ exitCode: 1, stderr: "TypeScript compilation failed" }), "agent_error");
  assert.equal(classifyAgentFailure({ exitCode: 1, stderr: "Memory limit exceeded" }), "agent_error");
  assert.equal(classifyAgentFailure({ providerAvailable: false }), "provider_unavailable");
  assert.equal(classifyAgentFailure({ exitCode: 0 }), null);
});

test("quota reset times are read off the providers' error text", () => {
  const now = new Date(2026, 9, 29, 10, 0, 0).getTime(); // 10:00 local
  assert.equal(parseQuotaReset("Claude AI usage limit reached|1761760800", now), 1761760800 * 1000);
  assert.equal(parseQuotaReset("Rate limited. Resets at 2026-10-29T15:00:00Z", now), Date.parse("2026-10-29T15:00:00Z"));
  assert.equal(parseQuotaReset("You've hit your usage limit. Try again in 2 days 3 hours.", now), now + (2 * 24 + 3) * 3600_000);
  assert.equal(parseQuotaReset("RESOURCE_EXHAUSTED. Please retry in 41.5s", now), now + 41_500);
  assert.equal(parseQuotaReset('{"retryDelay": "30s"}', now), now + 30_000);
  assert.equal(parseQuotaReset("limit resets in 1h20m", now), now + 80 * 60_000);
  assert.equal(parseQuotaReset("5-hour limit reached, resets 3pm (Europe/Paris)", now), new Date(2026, 9, 29, 15, 0).getTime());
  assert.equal(parseQuotaReset("try again at 9:30", now), new Date(2026, 9, 30, 9, 30).getTime(), "a time already past today means tomorrow");
  assert.equal(parseQuotaReset("usage limit reached", now), null);
  assert.equal(parseQuotaReset("resets in a while", now), null);
});
