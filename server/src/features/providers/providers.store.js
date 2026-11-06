/**
 * Provider connections (OpenRouter API keys) used by OpenCode agents: CRUD plus persistence to
 * providers.config.json. That file holds secrets, so it is git-ignored and the full key never
 * leaves the server — routes hand out publicConnection() only.
 */
import path from "node:path";
import { nanoid } from "nanoid";
import { listAgents } from "../agents/agents.store.js";
import { SERVER_DIR } from "../../core/config.js";
import { loadJson, saveJson } from "../../core/json-file.js";
import { normalizeConnectionInput } from "./provider-model.js";

const PROVIDERS_FILE = path.join(SERVER_DIR, "providers.config.json");

let CONNECTIONS = loadJson(PROVIDERS_FILE, []).map((c) => ({ id: String(c.id || nanoid(8)), ...normalizeConnectionInput(c) }));

function saveConnections() {
  saveJson(PROVIDERS_FILE, CONNECTIONS);
}

function listConnections() {
  return CONNECTIONS;
}

function getConnection(id) {
  return CONNECTIONS.find((c) => c.id === id) || null;
}

/** The one marked default, else the first: what agents without their own connection use. */
function getDefaultConnection() {
  return CONNECTIONS.find((c) => c.isDefault) || CONNECTIONS[0] || null;
}

/** An agent's connection, falling back to the default one when it has none (or it was deleted). */
function connectionForAgent(agent) {
  return (agent?.connectionId && getConnection(agent.connectionId)) || getDefaultConnection();
}

/** Exactly one default at a time: setting one clears the others. */
function applyDefault(connection) {
  if (connection.isDefault) for (const c of CONNECTIONS) if (c !== connection) c.isDefault = false;
  if (!CONNECTIONS.some((c) => c.isDefault) && CONNECTIONS[0]) CONNECTIONS[0].isDefault = true;
}

function createConnection(input) {
  const connection = { id: nanoid(8), ...normalizeConnectionInput(input) };
  if (!connection.apiKey) throw new Error("Thiếu API key.");
  CONNECTIONS.push(connection);
  applyDefault(connection);
  saveConnections();
  return connection;
}

function updateConnection(id, input) {
  const idx = CONNECTIONS.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  CONNECTIONS[idx] = { id, ...normalizeConnectionInput({ ...CONNECTIONS[idx], ...input, apiKey: input.apiKey }, CONNECTIONS[idx]) };
  applyDefault(CONNECTIONS[idx]);
  saveConnections();
  return CONNECTIONS[idx];
}

/** Refused while an agent still points at it: the agent would silently switch to another key. */
function deleteConnection(id) {
  const users = listAgents()
    .filter((a) => a.connectionId === id)
    .map((a) => a.name);
  if (users.length) {
    throw new Error(`Kết nối đang được dùng bởi agent: ${users.join(", ")}. Đổi kết nối của (các) agent đó trước rồi mới xoá.`);
  }
  const before = CONNECTIONS.length;
  CONNECTIONS = CONNECTIONS.filter((c) => c.id !== id);
  if (CONNECTIONS.length && !CONNECTIONS.some((c) => c.isDefault)) CONNECTIONS[0].isDefault = true;
  saveConnections();
  return CONNECTIONS.length < before;
}

export { listConnections, getConnection, getDefaultConnection, connectionForAgent, createConnection, updateConnection, deleteConnection };
