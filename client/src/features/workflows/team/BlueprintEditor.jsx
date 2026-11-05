import React from "react";
import { IconClose, ProviderIcon } from "../../../shared/Icons.jsx";
import { usePreferences } from "../../../app/PreferencesContext.jsx";
import { Button, CheckboxField, ChipSelect, InfoTip, Select, Textarea, TextInput } from "../../../shared/components/index.js";
import { DetailField } from "../../../shared/components/DetailLayout.jsx";

const PROVIDERS = ["claude", "codex", "gemini"];
export const ACCESS_LEVELS = ["read", "write", "full"];
// Same caps as MAX_BLUEPRINT_PROVIDERS and the tool rules in server/src/features/runs/spawn-policy.js.
const MAX_PROVIDERS = 6;
const SUBAGENT_TOOL = "Task";
const WRITE_TOOLS = ["Edit", "Write", "NotebookEdit", "Bash"];

export const BLANK_BLUEPRINT = {
  name: "",
  role: "",
  instructions: "",
  skillIds: [],
  accessLevel: "read",
  providers: [{ provider: "claude", model: "", instructions: "" }],
  tools: null,
};

/** The models offered for a provider: the CLI default first, plus a saved model the list lacks. */
function modelOptions(meta, provider, current, t) {
  const list = { claude: meta?.models, codex: meta?.codexModels, gemini: meta?.geminiModels }[provider] || [];
  const named = list.filter((m) => m.value).map((m) => ({ value: m.value, label: m.label }));
  const options = [{ value: "", label: t("workflows.blueprint.defaultModel") }, ...named];
  if (current && !named.some((m) => m.value === current)) options.push({ value: current, label: current });
  return options;
}

/**
 * A blueprint's providers in the order the server tries them (team-calls.js spawnBlueprint): the
 * first that is installed and can do the job runs. Each row has its model and the instructions
 * added for that provider only, and says when its CLI isn't installed here.
 */
function BlueprintProviderList({ providers, meta, onChange }) {
  const { t } = usePreferences();
  const availability = meta?.providerAvailability || {};
  const update = (i, patch) => onChange(providers.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  const move = (from, to) => {
    const next = providers.slice();
    [next[from], next[to]] = [next[to], next[from]];
    onChange(next);
  };

  return (
    <>
      <div className="field-label label-with-tip">
        {t("workflows.blueprint.providers")}
        <InfoTip>{t("workflows.blueprint.providers.hint")}</InfoTip>
      </div>
      {providers.map((p, i) => {
        const installed = availability[p.provider] !== false;
        return (
          <div key={i} className="blueprint-provider">
            <div className="branch-row member-agent-row">
              <span className="branch-target">
                {i + 1}. <ProviderIcon provider={p.provider} size={14} /> {t(`agents.provider.${p.provider}`)}
                {i === 0 && providers.length > 1 && <span className="member-agent-provider"> · {t("workflows.blueprint.providers.first")}</span>}
              </span>
              <span
                className={`card-tag ${installed ? "card-tag-ok" : "card-tag-error"}`}
                title={installed ? "" : t("agents.provider.unavailableWarning", { name: t(`agents.provider.${p.provider}`) })}
              >
                {installed ? t("workflows.blueprint.installed") : t("agents.provider.notInstalled")}
              </span>
              <Button variant="icon" title={t("workflows.team.memberAgents.up")} disabled={i === 0} onClick={() => move(i, i - 1)}>
                ↑
              </Button>
              <Button variant="icon" title={t("workflows.team.memberAgents.down")} disabled={i === providers.length - 1} onClick={() => move(i, i + 1)}>
                ↓
              </Button>
              <Button variant="icon" color="danger" title={t("common.delete")} onClick={() => onChange(providers.filter((_, j) => j !== i))}>
                <IconClose size={12} />
              </Button>
            </div>
            <Select
              label={t("workflows.blueprint.model")}
              value={p.model || ""}
              options={modelOptions(meta, p.provider, p.model, t)}
              onChange={(e) => update(i, { model: e.target.value })}
            />
            <Textarea
              label={t("workflows.blueprint.providerInstructions")}
              value={p.instructions || ""}
              placeholder={t("workflows.blueprint.providerInstructions.placeholder")}
              onChange={(e) => update(i, { instructions: e.target.value })}
            />
          </div>
        );
      })}
      {providers.length < MAX_PROVIDERS && (
        <select value="" onChange={(e) => e.target.value && onChange([...providers, { provider: e.target.value, model: "", instructions: "" }])}>
          <option value="">{providers.length ? t("workflows.blueprint.providers.addBackup") : t("workflows.blueprint.providers.add")}</option>
          {PROVIDERS.map((p) => (
            <option key={p} value={p}>
              {t(`agents.provider.${p}`)}
              {availability[p] === false ? ` (${t("agents.provider.notInstalled")})` : ""}
            </option>
          ))}
        </select>
      )}
    </>
  );
}

/**
 * Edit panel for one blueprint of a Team: a role the coordinator may spawn by name (see
 * server/src/features/runs/spawn-policy.js normalizeBlueprints). Its access level can't go above
 * the team's maxAccessLevel; higher levels are shown but can't be picked.
 */
export default function BlueprintEditor({ blueprint, maxAccessLevel = "read", skills, meta, onChange }) {
  const { t } = usePreferences();
  const b = { ...BLANK_BLUEPRINT, ...blueprint };
  const set = (patch) => onChange({ ...b, ...patch });
  const maxRank = ACCESS_LEVELS.indexOf(maxAccessLevel);
  const levelOptions = ACCESS_LEVELS.map((level, i) => ({
    value: level,
    label: t(`agents.access.${level}`),
    disabled: i > maxRank,
    title: i > maxRank ? t("workflows.blueprint.accessAboveMax", { max: t(`agents.access.${maxAccessLevel}`) }) : undefined,
  }));
  const usesClaude = b.providers.some((p) => p.provider === "claude");
  const toolOptions = (meta?.tools || [])
    .filter((tool) => tool !== SUBAGENT_TOOL && (b.accessLevel !== "read" || !WRITE_TOOLS.includes(tool)))
    .map((tool) => ({ value: tool, label: tool }));

  return (
    <>
      <TextInput
        label={t("workflows.blueprint.name")}
        value={b.name}
        placeholder={t("workflows.blueprint.name.placeholder")}
        onChange={(e) => set({ name: e.target.value.toLowerCase().replace(/\s+/g, "-") })}
        hint={t("workflows.blueprint.nameHint")}
      />
      <TextInput
        label={t("workflows.blueprint.role")}
        value={b.role}
        placeholder={t("workflows.blueprint.role.placeholder")}
        onChange={(e) => set({ role: e.target.value })}
        hint={t("workflows.blueprint.roleHint")}
      />
      <Textarea
        label={t("workflows.blueprint.instructions")}
        size="lg"
        value={b.instructions}
        placeholder={t("workflows.blueprint.instructions.placeholder")}
        onChange={(e) => set({ instructions: e.target.value })}
      />
      <DetailField label={t("workflows.blueprint.skills")} full>
        <ChipSelect
          options={(skills || []).map((s) => ({ value: s.id, label: s.name }))}
          selected={b.skillIds}
          onChange={(skillIds) => set({ skillIds })}
          emptyMessage={t("workflows.blueprint.noSkills")}
        />
      </DetailField>
      <Select
        label={t("workflows.blueprint.access")}
        value={b.accessLevel}
        options={levelOptions}
        onChange={(e) => {
          const accessLevel = e.target.value;
          // A read-only blueprint can't keep write tools (the server refuses that on save).
          const tools = accessLevel === "read" && b.tools ? b.tools.filter((tool) => !WRITE_TOOLS.includes(tool)) : b.tools;
          set({ accessLevel, tools });
        }}
        hint={t("workflows.blueprint.accessHint", { max: t(`agents.access.${maxAccessLevel}`) })}
      />
      <BlueprintProviderList providers={b.providers} meta={meta} onChange={(providers) => set({ providers })} />
      {usesClaude && (
        <>
          <CheckboxField
            id={`blueprintTools-${b.name || "new"}`}
            checked={Array.isArray(b.tools)}
            onChange={(on) => set({ tools: on ? toolOptions.map((o) => o.value) : null })}
            label={t("workflows.blueprint.limitTools")}
            hint={t("workflows.blueprint.toolsHint")}
          />
          {Array.isArray(b.tools) && (
            <DetailField label={t("workflows.blueprint.tools")} full>
              <ChipSelect options={toolOptions} selected={b.tools} onChange={(tools) => set({ tools })} />
            </DetailField>
          )}
        </>
      )}
    </>
  );
}
