/**
 * Keeps the API server local-only. It can start agents with an arbitrary `cwd`, sometimes with
 * a sandbox mode that lets them run anything, so another machine on the LAN or a random web
 * page open in the browser must not be able to reach it.
 *
 * - The server binds to loopback (HOST, default 127.0.0.1).
 * - Requests carrying a `Host` that isn't loopback are refused, which stops DNS-rebinding pages.
 * - Requests carrying an `Origin` outside ALLOWED_ORIGINS are refused outright, not just left
 *   without CORS headers, so "simple" cross-site requests (form posts, no preflight) fail too.
 *   No `Origin` at all means a non-browser client (curl, mcp-bridge) and is let through.
 * - `/api/internal/*` additionally needs INTERNAL_TOKEN, generated fresh on every start and
 *   handed to mcp-bridge through its environment.
 * - Optionally, ALLOWED_ROOTS limits which directories can be browsed or used as a run's cwd.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

export const HOST = process.env.HOST || "127.0.0.1";

export const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map((s) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);

export const INTERNAL_TOKEN = randomBytes(32).toString("hex");
export const INTERNAL_TOKEN_HEADER = "x-orchestrator-token";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackHost(host) {
  return LOOPBACK_HOSTNAMES.has(String(host || "").toLowerCase());
}

/** `Host` header value (`name[:port]`, IPv6 in brackets) → whether it names this machine. */
export function isAllowedHostHeader(hostHeader) {
  if (!hostHeader) return false;
  const name = String(hostHeader).toLowerCase().replace(/:\d+$/, "");
  return LOOPBACK_HOSTNAMES.has(name);
}

/** Missing Origin = not a browser, allowed. Anything else must be on the allowlist. */
export function isAllowedOrigin(origin, allowed = ALLOWED_ORIGINS) {
  if (origin === undefined || origin === null || origin === "") return true;
  return allowed.includes(String(origin).replace(/\/+$/, ""));
}

/** Express middleware: refuse non-loopback Host and foreign Origin before any route runs. */
export function requestGuard(req, res, next) {
  if (!isAllowedHostHeader(req.headers.host)) {
    return res.status(403).json({ error: "forbidden host" });
  }
  if (!isAllowedOrigin(req.headers.origin)) {
    return res.status(403).json({ error: "forbidden origin" });
  }
  next();
}

/** `verifyClient` for the WebSocket server — same Host/Origin rules as HTTP. */
export function verifyWsClient({ origin, req }) {
  return isAllowedHostHeader(req.headers.host) && isAllowedOrigin(origin);
}

/** Middleware for `/api/internal/*`: constant-time compare against INTERNAL_TOKEN. */
export function requireInternalToken(req, res, next) {
  const given = Buffer.from(String(req.headers[INTERNAL_TOKEN_HEADER] || ""));
  const expected = Buffer.from(INTERNAL_TOKEN);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

/** ---- optional directory allowlist ---- */

const caseInsensitiveFs = process.platform === "win32" || process.platform === "darwin";

function canonical(p) {
  const resolved = path.resolve(p);
  let real = resolved;
  try {
    real = realpathSync.native(resolved);
  } catch {
    // Doesn't exist (yet): fall back to the lexical path; callers fail on it later anyway.
  }
  return caseInsensitiveFs ? real.toLowerCase() : real;
}

/** ALLOWED_ROOTS is a PATH-style list (`;` on Windows, `:` elsewhere). Empty = no restriction. */
export function parseAllowedRoots(value = process.env.ALLOWED_ROOTS) {
  return String(value || "")
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => path.resolve(p));
}

export const ALLOWED_ROOTS = parseAllowedRoots();

/** True when `dir` is one of `roots` or inside one (symlinks resolved). Empty `roots` allows all. */
export function isPathAllowed(dir, roots = ALLOWED_ROOTS) {
  if (!roots.length) return true;
  const target = canonical(dir);
  return roots.some((root) => {
    const r = canonical(root);
    const rel = path.relative(r, target);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  });
}

/** Rejects a run's `cwd` outside ALLOWED_ROOTS (no-op when ALLOWED_ROOTS is unset): sends 403
 * and returns false, so a route can `if (!checkCwd(cwd, res)) return;`. */
export function checkCwd(cwd, res) {
  if (cwd && !isPathAllowed(String(cwd))) {
    res.status(403).json({ error: "cwd nằm ngoài các thư mục được phép (ALLOWED_ROOTS)" });
    return false;
  }
  return true;
}
