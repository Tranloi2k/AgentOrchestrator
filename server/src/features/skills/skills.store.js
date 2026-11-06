/**
 * Skills: reusable instruction blocks attached to agents. CRUD plus persistence to
 * skills.config.json, loaded once at startup and kept in memory.
 */
import path from "node:path";
import { nanoid } from "nanoid";
import { listAgents } from "../agents/agents.store.js";
import { listWorkflows } from "../workflows/workflows.store.js";
import { SERVER_DIR } from "../../core/config.js";
import { loadJson, saveJson } from "../../core/json-file.js";

const SKILLS_FILE = path.join(SERVER_DIR, "skills.config.json");

let SKILLS = loadJson(SKILLS_FILE, []);

function saveSkills() {
  saveJson(SKILLS_FILE, SKILLS);
}

function listSkills() {
  return SKILLS;
}

function getSkill(id) {
  return SKILLS.find((s) => s.id === id);
}

function normalizeSkillInput(input) {
  return {
    name: String(input.name || "Unnamed skill").slice(0, 80),
    description: String(input.description || ""),
    content: String(input.content || ""),
  };
}

function createSkill(input) {
  const skill = { id: nanoid(8), ...normalizeSkillInput(input) };
  SKILLS.push(skill);
  saveSkills();
  return skill;
}

function updateSkill(id, input) {
  const idx = SKILLS.findIndex((s) => s.id === id);
  if (idx === -1) return null;
  SKILLS[idx] = { id, ...normalizeSkillInput({ ...SKILLS[idx], ...input }) };
  saveSkills();
  return SKILLS[idx];
}

function deleteSkill(id) {
  const usedByAgents = listAgents().filter((a) => a.skillIds?.includes(id)).map((a) => a.name);
  if (usedByAgents.length) {
    throw new Error(`Skill đang được dùng bởi agent: ${usedByAgents.join(", ")}. Gỡ khỏi (các) agent đó trước rồi mới xoá.`);
  }
  // A Team's blueprints carry skills too; deleting one would leave the blueprint pointing at nothing.
  const usedByTeams = listWorkflows().filter((w) => (w.team?.blueprints || []).some((b) => b.skillIds?.includes(id))).map((w) => w.name);
  if (usedByTeams.length) {
    throw new Error(`Skill đang được dùng bởi blueprint trong workflow: ${usedByTeams.join(", ")}. Gỡ khỏi (các) blueprint đó trước rồi mới xoá.`);
  }
  const before = SKILLS.length;
  SKILLS = SKILLS.filter((s) => s.id !== id);
  saveSkills();
  return SKILLS.length < before;
}

export { listSkills, getSkill, createSkill, updateSkill, deleteSkill };
