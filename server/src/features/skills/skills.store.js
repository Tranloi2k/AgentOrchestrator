/**
 * Skills: reusable instruction blocks attached to agents. CRUD plus persistence to
 * skills.config.json, loaded once at startup and kept in memory.
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { nanoid } from "nanoid";
import { listAgents } from "../agents/agents.store.js";
import { SERVER_DIR, loadJson } from "../../core/config.js";

const SKILLS_FILE = path.join(SERVER_DIR, "skills.config.json");

let SKILLS = loadJson(SKILLS_FILE, []);

function saveSkills() {
  writeFileSync(SKILLS_FILE, JSON.stringify(SKILLS, null, 2), "utf-8");
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
  const before = SKILLS.length;
  SKILLS = SKILLS.filter((s) => s.id !== id);
  saveSkills();
  return SKILLS.length < before;
}

export { listSkills, getSkill, createSkill, updateSkill, deleteSkill };
