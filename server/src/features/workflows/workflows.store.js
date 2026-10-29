/**
 * Workflows: CRUD plus persistence to workflows.config.json, with save-time validation (see
 * workflow-model.js). Loaded once at startup and kept in memory.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { normalizeWorkflowInput, validateWorkflow } from "./workflow-model.js";
import { listAgents } from "../agents/agents.store.js";
import { SERVER_DIR, loadJson } from "../../core/config.js";

const WORKFLOWS_FILE = path.join(SERVER_DIR, "workflows.config.json");

// Workflows are migrated (legacy linear `steps` -> `nodes`/`edges` graph) right on load,
// then re-saved once so the file on disk always reflects the current graph shape.
let WORKFLOWS = loadJson(WORKFLOWS_FILE, []).map((w) => ({
  id: String(w.id || nanoid(8)),
  ...normalizeWorkflowInput(w),
}));
saveWorkflows();

function saveWorkflows() {
  writeFileSync(WORKFLOWS_FILE, JSON.stringify(WORKFLOWS, null, 2), "utf-8");
}

function listWorkflows() {
  return WORKFLOWS;
}

function getWorkflow(id) {
  return WORKFLOWS.find((w) => w.id === id);
}

/** Thrown by createWorkflow/updateWorkflow; `errors` is the list from validateWorkflow. */
class WorkflowValidationError extends Error {
  constructor(errors) {
    super("Workflow không hợp lệ");
    this.errors = errors;
  }
}

function checkWorkflow(input) {
  const errors = validateWorkflow(input, { agentExists: (id) => listAgents().some((a) => a.id === id) });
  if (errors.length) throw new WorkflowValidationError(errors);
}

function createWorkflow(input) {
  checkWorkflow(input);
  const workflow = { id: nanoid(8), ...normalizeWorkflowInput(input) };
  WORKFLOWS.push(workflow);
  saveWorkflows();
  return workflow;
}

/** The type is picked when the workflow is created and can't change afterwards. */
function updateWorkflow(id, input) {
  const idx = WORKFLOWS.findIndex((w) => w.id === id);
  if (idx === -1) return null;
  const merged = { ...WORKFLOWS[idx], ...input, type: WORKFLOWS[idx].type };
  checkWorkflow(merged);
  WORKFLOWS[idx] = { id, ...normalizeWorkflowInput(merged) };
  saveWorkflows();
  return WORKFLOWS[idx];
}

function deleteWorkflow(id) {
  const before = WORKFLOWS.length;
  WORKFLOWS = WORKFLOWS.filter((w) => w.id !== id);
  saveWorkflows();
  return WORKFLOWS.length < before;
}

export { listWorkflows, getWorkflow, createWorkflow, updateWorkflow, deleteWorkflow, WorkflowValidationError };
