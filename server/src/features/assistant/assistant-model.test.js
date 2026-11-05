import test from "node:test";
import assert from "node:assert/strict";
import { parseAssistantReply, lockDownAssistant, normalizeMessages, compactDraft, buildAssistantPrompt } from "./assistant-model.js";

test("a reply without a json block proposes nothing", () => {
  assert.deepEqual(parseAssistantReply("Bạn muốn mấy bước?"), { reply: "Bạn muốn mấy bước?", proposal: null, parseError: null });
});

test("the last json block is the proposal and is cut out of the reply", () => {
  const text = 'Ví dụ:\n```json\n{"name":"old"}\n```\nBản cuối:\n```json\n{"name":"new"}\n```\n';
  const { reply, proposal, parseError } = parseAssistantReply(text);
  assert.deepEqual(proposal, { name: "new" });
  assert.equal(parseError, null);
  assert.ok(reply.includes('{"name":"old"}'));
  assert.ok(!reply.includes('"new"'));
});

test("a broken or non-object json block is reported, not applied", () => {
  assert.ok(parseAssistantReply("```json\n{name: oops}\n```").parseError);
  assert.equal(parseAssistantReply("```json\n[1,2]\n```").parseError, "notAnObject");
  assert.equal(parseAssistantReply("```json\n[1,2]\n```").proposal, null);
});

test("the assistant agent runs read-only with every tool blocked and no plugins", () => {
  const tools = ["Read", "Edit", "Bash"];
  const locked = lockDownAssistant(
    { id: "a1", provider: "claude", model: "opus", accessLevel: "full", permissionMode: "bypassPermissions", allowedTools: tools, pluginIds: ["p"], appendSystemPrompt: "x" },
    tools,
  );
  assert.equal(locked.accessLevel, "read");
  assert.equal(locked.permissionMode, "default");
  assert.equal(locked.codexSandbox, "read-only");
  assert.equal(locked.agyMode, "plan");
  assert.deepEqual(locked.allowedTools, []);
  assert.deepEqual(locked.disallowedTools, tools);
  assert.deepEqual(locked.pluginIds, []);
  assert.equal(locked.model, "opus");
  assert.equal(locked.appendSystemPrompt, "x");
});

test("messages are cleaned and roles limited to user/assistant", () => {
  const out = normalizeMessages([{ role: "system", content: "hi" }, { role: "assistant", content: "ok" }, { content: "   " }, null]);
  assert.deepEqual(out, [
    { role: "user", content: "hi" },
    { role: "assistant", content: "ok" },
  ]);
});

test("the draft drops canvas positions and ids; the prompt carries draft and conversation", () => {
  const draft = { id: "w1", type: "pipeline", name: "W", nodes: [{ id: "n1", agentId: "a", x: 1, y: 2 }], edges: [] };
  const compact = compactDraft("workflow", draft);
  assert.deepEqual(compact.nodes, [{ id: "n1", agentId: "a" }]);
  assert.equal(compact.id, undefined);
  const prompt = buildAssistantPrompt({ target: "workflow", context: { agents: [] }, draft: compact, messages: [{ role: "user", content: "tạo pipeline" }] });
  assert.ok(prompt.includes("tạo pipeline"));
  assert.ok(prompt.includes('"name": "W"'));
});
