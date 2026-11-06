/**
 * Editor assistant: a chat beside the Workflow and Agent forms. A locally installed CLI (claude,
 * codex or agy) answers with the model picked in the chat, locked down to text only (see
 * lockDownAssistant), and a config it proposes is
 * normalized and validated here, then handed back for the client to put into the form. Nothing is
 * saved: the user still reviews the form and clicks Save.
 */
import { nanoid } from "nanoid";
import { runAgentProcess } from "../runs/cli-runners.js";
import { listAgents, normalizeAgentInput } from "../agents/agents.store.js";
import { listSkills } from "../skills/skills.store.js";
import { listPlugins } from "../plugins/plugins.store.js";
import { normalizeWorkflowInput, validateWorkflow } from "../workflows/workflow-model.js";
import { ACCESS_LEVELS } from "../agents/access.js";
import { DEFAULT_CWD, KNOWN_TOOLS, MODELS, CODEX_MODELS, AGY_MODELS, PROVIDERS, PROVIDER_AVAILABILITY } from "../../core/config.js";
import {
  ASSISTANT_TARGETS,
  ASSISTANT_RUN_PREFIX,
  lockDownAssistant,
  normalizeMessages,
  parseAssistantReply,
  buildAssistantPrompt,
  compactDraft,
} from "./assistant-model.js";

const ASSISTANT_TIMEOUT_MS = 5 * 60 * 1000;

/** Thrown for a request the client should fix (bad target, unknown agent, no message). */
export class AssistantRequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** What the assistant may pick from, so it uses real ids instead of inventing them. */
function contextFor(target) {
  const skills = listSkills().map((s) => ({ id: s.id, name: s.name, description: s.description }));
  if (target === "workflow") {
    return {
      agents: listAgents().map((a) => ({ id: a.id, name: a.name, description: a.description, provider: a.provider, model: a.model, accessLevel: a.accessLevel })),
      skills,
    };
  }
  const available = PROVIDERS.filter((p) => PROVIDER_AVAILABILITY[p]);
  const models = { claude: MODELS, codex: CODEX_MODELS, gemini: AGY_MODELS };
  return {
    providers: available,
    // OpenCode's models are OpenRouter's catalogue, fetched per connection: none to offer here.
    models: Object.fromEntries(available.map((p) => [p, models[p] || []])),
    accessLevels: ACCESS_LEVELS,
    tools: KNOWN_TOOLS,
    skills,
    plugins: listPlugins().map((p) => ({ id: p.id, name: p.name, description: p.description })),
  };
}

/** Proposal + the draft it replaces → the normalized config the form gets, plus validation errors. */
function finishProposal(target, draft, proposal) {
  const { id: _ignored, ...fields } = proposal;
  if (target === "agent") {
    return { proposal: normalizeAgentInput({ ...draft, ...fields }), errors: [] };
  }
  // A saved workflow's type can't change; a new one takes the assistant's pick.
  const merged = { ...draft, ...fields, type: draft?.type || fields.type };
  const errors = validateWorkflow(merged, {
    agentExists: (aid) => listAgents().some((a) => a.id === aid),
    skillExists: (sid) => listSkills().some((s) => s.id === sid),
  });
  return { proposal: normalizeWorkflowInput(merged), errors };
}

/** `provider`/`model`: a CLI installed on this machine and one of its models ("" = the CLI's default). */
export async function askAssistant({ target, provider, model, messages, draft }) {
  if (!ASSISTANT_TARGETS.includes(target)) throw new AssistantRequestError("target must be workflow or agent");
  const history = normalizeMessages(messages);
  if (!history.length || history.at(-1).role !== "user") throw new AssistantRequestError("Cần một tin nhắn của người dùng");
  if (!PROVIDERS.includes(provider)) throw new AssistantRequestError("Chưa chọn CLI cho trợ lý");
  if (!PROVIDER_AVAILABILITY[provider]) throw new AssistantRequestError(`CLI của provider "${provider}" chưa được cài trên server`, 503);
  // A throwaway agent: no saved config, just the CLI and model picked in the chat.
  const base = { id: "assistant", name: "Assistant", provider, model: String(model || ""), appendSystemPrompt: "", skillIds: [] };

  const prompt = buildAssistantPrompt({ target, context: contextFor(target), draft: compactDraft(target, draft), messages: history });
  const id = `${ASSISTANT_RUN_PREFIX}${nanoid(8)}`;
  const result = await runAgentProcess({
    runId: id,
    taskId: id,
    prompt,
    cwd: DEFAULT_CWD,
    agent: lockDownAssistant(base, KNOWN_TOOLS),
    timeoutMs: ASSISTANT_TIMEOUT_MS,
  });
  if (!result.ok && !result.resultText) {
    return { reply: "", proposal: null, errors: [], parseError: null, failureReason: result.failureReason || "error" };
  }

  const { reply, proposal, parseError } = parseAssistantReply(result.resultText);
  if (!proposal) return { reply, proposal: null, errors: [], parseError, failureReason: null };
  return { reply, ...finishProposal(target, draft || {}, proposal), parseError: null, failureReason: null };
}
