/**
 * Plugins: real Claude Code plugins attached to agents. CRUD plus persistence to
 * plugins.config.json; git plugins are cloned into server/plugins/<id>.
 */
import { writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { nanoid } from "nanoid";
import { removePluginFromAgents } from "../agents/agents.store.js";
import { SERVER_DIR, loadJson } from "../../core/config.js";

const PLUGINS_FILE = path.join(SERVER_DIR, "plugins.config.json");
const PLUGINS_DIR = path.join(SERVER_DIR, "plugins");

let PLUGINS = loadJson(PLUGINS_FILE, []);

function savePlugins() {
  writeFileSync(PLUGINS_FILE, JSON.stringify(PLUGINS, null, 2), "utf-8");
}

function listPlugins() {
  return PLUGINS;
}

function getPlugin(id) {
  return PLUGINS.find((p) => p.id === id);
}

/**
 * A plugin references a real Claude Code plugin (a directory with a
 * `.claude-plugin/plugin.json` manifest, e.g. https://github.com/DietrichGebert/ponytail).
 * sourceType:
 *  - "git"  -> sourceValue is a git URL; we `git clone` it once into server/plugins/<id>
 *              and pass `--plugin-dir <clonedPath>` to `claude` for agents that use it.
 *  - "dir"  -> sourceValue is an already-local directory path; used as-is with `--plugin-dir`.
 *  - "url"  -> sourceValue is a URL to a plugin .zip; passed as `--plugin-url`.
 */
function createPlugin(input) {
  const id = nanoid(8);
  const name = String(input.name || "Unnamed plugin").slice(0, 80);
  const description = String(input.description || "");
  const sourceType = ["git", "dir", "url"].includes(input.sourceType) ? input.sourceType : "git";
  const sourceValue = String(input.sourceValue || "").trim();
  if (!sourceValue) throw new Error("Thiếu sourceValue (git URL / đường dẫn / plugin URL)");

  let localPath = "";
  if (sourceType === "git") {
    localPath = path.join(PLUGINS_DIR, id);
    execFileSync("git", ["clone", "--depth", "1", sourceValue, localPath], { stdio: "pipe" });
  } else if (sourceType === "dir") {
    if (!existsSync(sourceValue)) throw new Error(`Không tìm thấy thư mục: ${sourceValue}`);
    localPath = sourceValue;
  }

  const plugin = { id, name, description, sourceType, sourceValue, localPath };
  PLUGINS.push(plugin);
  savePlugins();
  return plugin;
}

function updatePlugin(id, input) {
  const idx = PLUGINS.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  const existing = PLUGINS[idx];
  PLUGINS[idx] = {
    ...existing,
    name: input.name !== undefined ? String(input.name).slice(0, 80) : existing.name,
    description: input.description !== undefined ? String(input.description) : existing.description,
  };
  savePlugins();
  return PLUGINS[idx];
}

function deletePlugin(id) {
  const plugin = getPlugin(id);
  if (!plugin) return false;
  if (plugin.sourceType === "git" && plugin.localPath && plugin.localPath.startsWith(PLUGINS_DIR)) {
    try {
      rmSync(plugin.localPath, { recursive: true, force: true });
    } catch {
      /* ignore cleanup failure */
    }
  }
  PLUGINS = PLUGINS.filter((p) => p.id !== id);
  savePlugins();
  removePluginFromAgents(id);
  return true;
}

export { listPlugins, getPlugin, createPlugin, updatePlugin, deletePlugin };
