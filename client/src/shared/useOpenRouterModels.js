import { useEffect, useState } from "react";
import { api } from "./api.js";

// Connection id ("default" for the default one) -> promise of its model list, shared by every
// form on the page so switching back and forth doesn't refetch.
const cache = new Map();

/**
 * The OpenRouter models a connection may use (free ones only on a free connection), as
 * [{ value, label, free, promptPerM, completionPerM, tools }]. Nothing is fetched until `enabled`.
 */
export function useOpenRouterModels(connectionId, enabled = true) {
  const key = connectionId || "default";
  const [state, setState] = useState({ models: [], loading: false, error: "" });

  useEffect(() => {
    if (!enabled) return undefined;
    let alive = true;
    if (!cache.has(key)) {
      cache.set(
        key,
        api.providerModels(key).then((d) => d.models || []).catch((err) => {
          cache.delete(key); // try again next time
          throw err;
        })
      );
    }
    setState((s) => ({ ...s, loading: true, error: "" }));
    cache
      .get(key)
      .then((models) => alive && setState({ models, loading: false, error: "" }))
      .catch((err) => alive && setState({ models: [], loading: false, error: err.message }));
    return () => {
      alive = false;
    };
  }, [key, enabled]);

  return state;
}

/** "Qwen3 Coder · free" / "GPT-5 · $1.25 / $10 per 1M tokens", plus a note when it can't call tools. */
export function openRouterModelLabel(m, t) {
  const price = m.free ? t("agents.model.free") : t("agents.model.price", { in: m.promptPerM ?? "?", out: m.completionPerM ?? "?" });
  return `${m.label} · ${price}${m.tools === false ? ` ${t("agents.model.noTools")}` : ""}`;
}
