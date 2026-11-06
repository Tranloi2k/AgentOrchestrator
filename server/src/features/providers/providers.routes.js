import {
  listConnections,
  getConnection,
  getDefaultConnection,
  createConnection,
  updateConnection,
  deleteConnection,
} from "./providers.store.js";
import { publicConnection, modelsForTier } from "./provider-model.js";

const OPENROUTER_API = "https://openrouter.ai/api/v1";
const MODELS_TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;

/** OpenRouter's whole catalogue, shared by every connection; refreshed at most once an hour. */
let modelCache = { at: 0, data: null };

async function fetchOpenRouter(pathname, apiKey) {
  const res = await fetch(`${OPENROUTER_API}${pathname}`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON: reported by status below */
  }
  if (!res.ok) throw Object.assign(new Error(body?.error?.message || `OpenRouter trả về HTTP ${res.status}`), { status: res.status });
  return body;
}

async function openRouterModels() {
  if (modelCache.data && Date.now() - modelCache.at < MODELS_TTL_MS) return modelCache.data;
  const body = await fetchOpenRouter("/models");
  modelCache = { at: Date.now(), data: Array.isArray(body?.data) ? body.data : [] };
  return modelCache.data;
}

/** "default" names whichever connection is the default (what blueprints and spawned agents use). */
const resolve = (id) => (id === "default" ? getDefaultConnection() : getConnection(id));

/** Provider connections (OpenRouter keys for OpenCode agents). The key itself never goes out. */
export function register(app) {
  app.get("/api/providers", (req, res) => {
    res.json({ providers: listConnections().map(publicConnection) });
  });

  app.post("/api/providers", (req, res) => {
    try {
      res.json({ provider: publicConnection(createConnection(req.body || {})) });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.put("/api/providers/:id", (req, res) => {
    const connection = updateConnection(req.params.id, req.body || {});
    if (!connection) return res.status(404).json({ error: "not found" });
    res.json({ provider: publicConnection(connection) });
  });

  app.delete("/api/providers/:id", (req, res) => {
    try {
      const ok = deleteConnection(req.params.id);
      if (!ok) return res.status(404).json({ error: "not found" });
      res.json({ ok: true });
    } catch (err) {
      res.status(409).json({ error: err.message });
    }
  });

  /** Checks the key against OpenRouter: valid or not, its limit, how much is used, free tier. */
  app.post("/api/providers/:id/test", async (req, res) => {
    const connection = resolve(req.params.id);
    if (!connection) return res.status(404).json({ error: "not found" });
    try {
      const { data } = await fetchOpenRouter("/key", connection.apiKey);
      res.json({
        ok: true,
        label: data?.label || null,
        limit: data?.limit ?? null,
        limitRemaining: data?.limit_remaining ?? null,
        usage: data?.usage ?? null,
        isFreeTier: !!data?.is_free_tier,
      });
    } catch (err) {
      res.json({ ok: false, error: err.status === 401 ? "API key không hợp lệ (OpenRouter trả về 401)." : err.message });
    }
  });

  /** The models this connection may pick: free ones only for a free connection. */
  app.get("/api/providers/:id/models", async (req, res) => {
    const connection = resolve(req.params.id);
    if (!connection) return res.status(404).json({ error: "not found" });
    try {
      res.json({ models: modelsForTier(await openRouterModels(), connection.tier) });
    } catch (err) {
      res.status(502).json({ error: `Không tải được danh sách model từ OpenRouter: ${err.message}` });
    }
  });
}
