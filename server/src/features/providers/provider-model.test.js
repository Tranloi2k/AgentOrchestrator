import test from "node:test";
import assert from "node:assert/strict";
import { normalizeConnectionInput, maskKey, publicConnection, isFreeModel, modelsForTier, effectiveModel, FALLBACK_MODEL } from "./provider-model.js";

const KEY = "sk-or-v1-0123456789abcdef0123456789abcdef";

test("the browser never gets the key, only a masked form", () => {
  const pub = publicConnection({ id: "c1", ...normalizeConnectionInput({ name: "Free", tier: "free", apiKey: KEY }) });
  assert.equal(pub.apiKey, undefined);
  assert.equal(pub.hasKey, true);
  assert.equal(pub.maskedKey, "sk-or-v1-…cdef");
  assert.doesNotMatch(JSON.stringify(pub), /0123456789/);
  assert.equal(maskKey(""), "");
  assert.equal(maskKey("short"), "…rt");
});

test("an update with an empty key keeps the saved one", () => {
  const saved = normalizeConnectionInput({ name: "Paid", tier: "paid", apiKey: KEY });
  assert.equal(normalizeConnectionInput({ name: "Paid 2", apiKey: "" }, saved).apiKey, KEY);
  assert.equal(normalizeConnectionInput({ apiKey: "sk-or-v1-new" }, saved).apiKey, "sk-or-v1-new");
});

test("unknown tier/kind fall back to a free OpenRouter connection", () => {
  const c = normalizeConnectionInput({ tier: "gold", kind: "x", apiKey: KEY });
  assert.equal(c.tier, "free");
  assert.equal(c.kind, "openrouter");
});

test("a free connection only lists free models; tool-capable ones first", () => {
  const raw = [
    { id: "openai/gpt-5", name: "GPT-5", pricing: { prompt: "0.00000125", completion: "0.00001" }, supported_parameters: ["tools"] },
    { id: "meta/llama:free", name: "Llama", pricing: { prompt: "0", completion: "0" }, supported_parameters: [] },
    { id: "qwen/qwen3-coder:free", name: "Qwen3 Coder", pricing: { prompt: "0", completion: "0" }, supported_parameters: ["tools"] },
  ];
  assert.equal(isFreeModel(raw[0]), false);
  assert.equal(isFreeModel(raw[1]), true);
  assert.deepEqual(modelsForTier(raw, "free").map((m) => m.value), ["qwen/qwen3-coder:free", "meta/llama:free"]);
  const paid = modelsForTier(raw, "paid");
  assert.equal(paid.length, 3);
  const gpt = paid.find((m) => m.value === "openai/gpt-5");
  assert.equal(gpt.promptPerM, 1.25);
  assert.equal(gpt.completionPerM, 10);
});

test("an agent's own model wins, then the connection's default, then OpenRouter's free router", () => {
  assert.equal(effectiveModel("qwen/qwen3-coder:free", { defaultModel: "x/y" }), "qwen/qwen3-coder:free");
  assert.equal(effectiveModel("", { defaultModel: "x/y:free" }), "x/y:free");
  assert.equal(effectiveModel("", { defaultModel: "" }), FALLBACK_MODEL);
  assert.equal(effectiveModel(undefined, null), "openrouter/free");
});
