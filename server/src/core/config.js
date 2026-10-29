/**
 * Static configuration shared by every other module: where things live on disk, the model and
 * tool lists the UI offers, and which provider CLIs are actually installed.
 */
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import spawn from "cross-spawn";

// This file is server/src/core/config.js. SERVER_DIR is server/ — where the data files live
// (*.config.json, runs.json, plugins/), kept outside src/ so code moves never touch them.
const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SERVER_DIR = path.resolve(SRC_DIR, "..");

const DEFAULT_CWD = process.env.TARGET_DIR || path.resolve(SERVER_DIR, "..");
const BRIDGE_SCRIPT = path.join(SRC_DIR, "features", "bridge", "mcp-bridge.js");
const MAX_CALL_DEPTH = 3; // caps agent-calls-agent chains so a bad config can't recurse forever

const MODELS = [
  { value: "", label: "Mặc định (theo cấu hình CLI)" },
  { value: "sonnet", label: "Sonnet 5" },
  { value: "opus", label: "Opus 5" },
  { value: "fable", label: "Fable 5" },
  { value: "claude-haiku-4-5-20251001", label: "Haiku 4.5" },
];

// Claude Code's own built-in sub-agent tool. The CLI calls it "Task" (that exact string is what
// --allowedTools expects), but the UI shows it under a plainer name — "Task" means nothing to a
// user in an app already full of "tasks". Listed explicitly so it's toggleable in the
// allowedTools/disallowedTools UI instead of only working when a tool list is left unrestricted.
const SUBAGENT_TOOL = "Task";

const KNOWN_TOOLS = ["Read", "Edit", "Write", "Bash", "Grep", "Glob", "WebFetch", "WebSearch", "NotebookEdit", SUBAGENT_TOOL];

// Injected automatically when an agent has the sub-agent tool ticked (see buildSystemPrompt).
// Ticking the tool in the UI is meant to be the entire setup — without this the agent *can*
// spawn sub-agents but rarely thinks to, so every prompt had to repeat "use the Task tool...".
const SUBAGENT_SYSTEM_PROMPT = [
  "## Chia việc cho sub-agent",
  'Bạn được phép tạo sub-agent để làm giúp một phần việc: dùng tool `Task` với `subagent_type: "general-purpose"`, mô tả nhiệm vụ, rồi chờ kết quả trả về.',
  "CHỦ ĐỘNG dùng khi công việc có thể tách thành các phần độc lập — khảo sát nhiều thư mục/chủ đề cùng lúc, tra cứu tốn nhiều bước, việc lặp lại trên nhiều file. Không cần người dùng nhắc mới dùng.",
  "KHÔNG dùng khi việc đủ nhỏ để tự làm nhanh hơn, hoặc khi các phần phụ thuộc chặt chẽ vào nhau.",
  "Sub-agent không thấy được hội thoại của bạn: mỗi lần giao việc phải mô tả đầy đủ bối cảnh và nói rõ cần nhận lại thông tin gì. Bạn chịu trách nhiệm tổng hợp kết quả của các sub-agent thành câu trả lời cuối cùng.",
].join("\n");

// Agent "provider" = which local CLI actually runs the agent. All are spawned as a local,
// already-logged-in CLI (no API key stored by this app) — "claude" (Claude Code CLI, the
// original/default), "codex" (OpenAI Codex CLI, `codex exec --json ...`) or "gemini" (Google's
// Antigravity CLI `agy`, which replaced the old `gemini` command; the provider id stays
// "gemini" so saved agents keep working).
const PROVIDERS = ["claude", "codex", "gemini"];

/**
 * Where the agy binary is. Its installer adds %LOCALAPPDATA%\agy\bin to the user PATH, but a
 * server started from a terminal opened before the install doesn't see that yet, so the default
 * install location is checked directly too.
 */
function resolveAgyBin() {
  if (process.env.AGY_BIN) return process.env.AGY_BIN;
  const installed = process.platform === "win32" && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "agy", "bin", "agy.exe") : null;
  return installed && existsSync(installed) ? installed : "agy";
}
const AGY_BIN = resolveAgyBin();

/** `agy models` prints "<id>\t<label>" per line for what the signed-in account can use. Read once
 * at startup like the Codex cache; on any failure only the CLI default is offered. */
function loadAgyModels() {
  const fallback = [{ value: "", label: "Mặc định (theo cấu hình agy)" }];
  try {
    const res = spawn.sync(AGY_BIN, ["models"], { encoding: "utf-8", timeout: 20000 });
    if (res.error || res.status !== 0) return fallback;
    const models = String(res.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.split("\t"))
      .filter(([id]) => /^[\w.-]+$/.test(id || ""))
      .map(([id, label]) => ({ value: id, label: (label || id).trim() }));
    return [...fallback, ...models];
  } catch {
    return fallback;
  }
}

/** The locally-installed Codex CLI already fetches (and caches) the account's real available
 * model list on login — reading it beats hardcoding slugs we'd have no way to keep in sync
 * with what the user's own Codex account actually offers. Falls back to just the blank
 * "CLI default" option if the cache doesn't exist yet (e.g. codex never run once locally). */
function loadCodexModels() {
  const fallback = [{ value: "", label: "Mặc định (theo cấu hình Codex)" }];
  try {
    const file = path.join(homedir(), ".codex", "models_cache.json");
    const data = JSON.parse(readFileSync(file, "utf-8"));
    const models = Array.isArray(data.models) ? data.models : [];
    if (!models.length) return fallback;
    return [
      ...fallback,
      ...models.filter((m) => m.slug).map((m) => ({ value: m.slug, label: m.display_name || m.slug })),
    ];
  } catch {
    return fallback;
  }
}
const CODEX_MODELS = loadCodexModels();

/** Detects whether each provider's CLI is actually installed & on PATH, so the UI can refuse
 * to offer picking a provider that would just fail at spawn time with a confusing ENOENT.
 * Cheap `--version` probe, done once at startup — a CLI being installed/removed mid-session is
 * rare enough that "restart the server to pick it up" is an acceptable tradeoff for not
 * re-probing (and paying a process-spawn cost) on every `/api/meta` request. */
function detectCliAvailable(cmd) {
  try {
    const res = spawn.sync(cmd, ["--version"], { stdio: "ignore" });
    return !res.error;
  } catch {
    return false;
  }
}
const PROVIDER_AVAILABILITY = {
  claude: detectCliAvailable("claude"),
  codex: detectCliAvailable("codex"),
  gemini: detectCliAvailable(AGY_BIN),
};
const AGY_MODELS = PROVIDER_AVAILABILITY.gemini ? loadAgyModels() : [{ value: "", label: "Mặc định (theo cấu hình agy)" }];

function loadJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

export {
  DEFAULT_CWD,
  BRIDGE_SCRIPT,
  MAX_CALL_DEPTH,
  MODELS,
  SUBAGENT_TOOL,
  KNOWN_TOOLS,
  SUBAGENT_SYSTEM_PROMPT,
  PROVIDERS,
  CODEX_MODELS,
  AGY_BIN,
  AGY_MODELS,
  PROVIDER_AVAILABILITY,
  loadJson,
};
