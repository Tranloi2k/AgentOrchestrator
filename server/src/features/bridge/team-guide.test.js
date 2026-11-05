import test from "node:test";
import assert from "node:assert/strict";
import { teamGuide } from "./team-guide.js";

const blueprints = [
  { name: "painter", role: "Makes images.", accessLevel: "write", providers: ["gemini", "claude (sonnet)"] },
  { name: "writer", role: "Writes copy", accessLevel: "read", providers: ["claude"] },
];

test("teamGuide: nothing to add without blueprints or providers to spawn from", () => {
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

test("teamGuide: a team that may define its own agents is told how", () => {
  const alone = teamGuide({ members: [], adHoc: true });
  assert.match(alone, /KHÔNG có thành viên cố định/);
  assert.match(alone, /name \+ role \+ instructions \+ workItemId/);
  assert.doesNotMatch(alone, /Blueprint:/);

  const both = teamGuide({ members: [{ id: "fe" }], blueprints, adHoc: true });
  assert.match(both, /ask_agent, agentId = "fe"/);
  assert.match(both, /khi có blueprint hợp vai trò; không có thì tự định nghĩa agent/);
  assert.match(both, /blueprint="painter"/);
});
