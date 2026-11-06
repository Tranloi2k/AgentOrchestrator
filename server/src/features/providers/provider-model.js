/**
 * Provider connections, pure logic: what a stored connection looks like, how its key is shown to
 * the browser, and how OpenRouter's model catalogue is cut down to what a connection may use.
 * Kept free of file I/O so it can be tested without touching providers.config.json.
 */

export const CONNECTION_KINDS = ["openrouter"];
export const CONNECTION_TIERS = ["free", "paid"];

// OpenRouter's own router over its free models: what a connection runs when it names no default
// model, and an agent or spawn names none either.
export const FALLBACK_MODEL = "openrouter/free";

/** The OpenRouter model an OpenCode agent runs: its own, else its connection's default. */
export function effectiveModel(agentModel, connection) {
  return String(agentModel || "").trim() || connection?.defaultModel || FALLBACK_MODEL;
}

/**
 * A connection as stored. `apiKey` is required on create; on update an empty one keeps the key
 * already saved (the form never gets the real key back, only its masked form).
 */
export function normalizeConnectionInput(input, previous = null) {
  const apiKey = String(input.apiKey || "").trim() || previous?.apiKey || "";
  return {
    name: String(input.name || "OpenRouter").trim().slice(0, 80) || "OpenRouter",
    kind: CONNECTION_KINDS.includes(input.kind) ? input.kind : "openrouter",
    tier: CONNECTION_TIERS.includes(input.tier) ? input.tier : "free",
    apiKey: apiKey.slice(0, 500),
    // Used when an agent or a spawned agent names no model; "" = FALLBACK_MODEL.
    defaultModel: String(input.defaultModel || "").trim().slice(0, 100),
    isDefault: !!input.isDefault,
  };
}

/** `sk-or-v1-abc…wxyz` → `sk-or-v1-…wxyz`: enough to tell two keys apart, useless to anyone else. */
export function maskKey(key) {
  const k = String(key || "");
  if (!k) return "";
  if (k.length <= 12) return "…" + k.slice(-2);
  const prefix = k.startsWith("sk-or-v1-") ? "sk-or-v1-" : k.slice(0, 4);
  return `${prefix}…${k.slice(-4)}`;
}

/** What the browser gets: everything but the key itself. */
export function publicConnection(c) {
  const { apiKey, ...rest } = c;
  return { ...rest, hasKey: !!apiKey, maskedKey: maskKey(apiKey) };
}

/** A model OpenRouter serves for nothing: its id ends in ":free" or both prices are zero. */
export function isFreeModel(m) {
  if (String(m?.id || "").endsWith(":free")) return true;
  const p = m?.pricing || {};
  return Number(p.prompt) === 0 && Number(p.completion) === 0;
}

/**
 * OpenRouter's /models entries → { value, label, free, promptPerM, completionPerM, contextLength,
 * tools }. A free connection only gets free models (a paid one would fail without credit anyway).
 */
export function modelsForTier(raw, tier) {
  const perMillion = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v) * 1e6 * 1000) / 1000 : null);
  return (Array.isArray(raw) ? raw : [])
    .filter((m) => m?.id)
    .filter((m) => tier !== "free" || isFreeModel(m))
    .map((m) => ({
      value: m.id,
      label: m.name || m.id,
      free: isFreeModel(m),
      promptPerM: perMillion(m.pricing?.prompt),
      completionPerM: perMillion(m.pricing?.completion),
      contextLength: Number(m.context_length) || null,
      // OpenCode drives the model through tool calls; one without them can only chat.
      tools: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes("tools") : null,
    }))
    .sort((a, b) => Number(b.tools === true) - Number(a.tools === true) || a.label.localeCompare(b.label));
}
