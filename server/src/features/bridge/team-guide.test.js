import test from "node:test";
import assert from "node:assert/strict";
import { teamGuide } from "./team-guide.js";

const blueprints = [
  { name: "painter", role: "Makes images.", accessLevel: "write", providers: ["gemini", "claude (sonnet)"] },
  { name: "writer", role: "Writes copy", accessLevel: "read", providers: ["claude"] },
];

test("teamGuide: nothing to add without blueprints", () => {
  assert.equal(teamGuide({ members: [{ id: "dev" }] }), "");
  assert.equal(teamGuide(), "");
});

test("teamGuide: a team without members is told to spawn what the job needs from its blueprints", () => {
  const text = teamGuide({ members: [], blueprints });
  assert.match(text, /KHÔNG có thành viên cố định/);
  assert.match(text, /blueprint="painter" \(quyền write\): Makes images\. Provider theo thứ tự: gemini → claude \(sonnet\)\./);
  assert.match(text, /blueprint="writer" \(quyền read\)/);
  assert.doesNotMatch(text, /ask_agent/);
});

test("teamGuide: with members it lists both and says when to use which", () => {
  const text = teamGuide({ members: [{ id: "fe" }, { id: "reviewer" }], blueprints });
  assert.match(text, /ask_agent, agentId = "fe", "reviewer"/);
  assert.match(text, /vị trí cố định/);
  assert.match(text, /spawn_agent với blueprint \+ workItemId/);
  assert.match(text, /blueprint="painter"/);
});
