import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../../shared/api.js";
import { usePreferences } from "../../app/PreferencesContext.jsx";
import DetailPage, { DetailSection, DetailField, DetailFieldGrid } from "../../shared/components/DetailPage.jsx";
import {
  TextInput,
  Select,
  Textarea,
  CheckboxField,
  ChipSelect,
  HelperText,
  ErrorBox,
} from "../../shared/components/index.js";
import ToolPermissionSelect from "./ToolPermissionSelect.jsx";

const PROVIDERS = ["claude", "codex", "gemini"];
const ACCESS_LEVELS = ["read", "write", "full"];

// Claude Code's sub-agent tool is literally named "Task" in the CLI — meaningless in a UI that
// already calls every workflow step a task, so it gets a plain-language label + tooltip. Every
// other tool keeps its real name (Read/Edit/Bash... are self-explanatory).
const SUBAGENT_TOOL = "Task";
const RENAMED_TOOLS = {
  [SUBAGENT_TOOL]: { labelKey: "agents.tool.subagent", titleKey: "agents.tool.subagent.desc" },
};

// Provider settings derived from the access level (server/access.js). "Advanced" may only pick
// a value at or below the level; changing the level resets them to that level's default.
const ADVANCED_FIELDS = ["permissionMode", "codexSandbox", "agyMode"];

const BLANK = {
  name: "",
  description: "",
  provider: "claude",
  model: "",
  accessLevel: "write",
  permissionMode: "acceptEdits",
  codexSandbox: "workspace-write",
  codexNetworkAccess: false,
  agyMode: "accept-edits",
  // Allowlist: tools not listed here are blocked. New agents start with every tool except the
  // sub-agent one (filled in once /api/meta says which tools exist).
  toolPolicy: "allowlist",
  allowedTools: [],
  appendSystemPrompt: "",
  skillIds: [],
  pluginIds: [],
};

export default function AgentDetailPage() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const { t } = usePreferences();
  const [form, setForm] = useState(BLANK);
  const [meta, setMeta] = useState(null);
  const [skills, setSkills] = useState([]);
  const [plugins, setPlugins] = useState([]);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.meta().then((d) => {
      setMeta(d);
      if (isNew) setForm((f) => ({ ...f, allowedTools: d.tools.filter((tool) => tool !== SUBAGENT_TOOL) }));
    });
    api.listSkills().then((d) => setSkills(d.skills));
    api.listPlugins().then((d) => setPlugins(d.plugins));

    if (isNew) return;

    api.listAgents().then((d) => {
      const agent = d.agents.find((a) => a.id === id);
      if (agent) {
        setForm({
          ...BLANK,
          ...agent,
          allowedTools: Array.isArray(agent.allowedTools) ? agent.allowedTools : [],
          skillIds: Array.isArray(agent.skillIds) ? agent.skillIds : [],
          pluginIds: Array.isArray(agent.pluginIds) ? agent.pluginIds : [],
        });
      } else setError("Agent not found");
      setLoading(false);
    });
  }, [id, isNew]);

  const providerAvailability = meta?.providerAvailability || { claude: true, codex: true, gemini: true };
  const levelOptions = meta?.accessOptions?.[form.accessLevel] || {};

  /** A new level resets the provider settings to that level's default (the last allowed value). */
  function setAccessLevel(accessLevel) {
    const options = meta?.accessOptions?.[accessLevel] || {};
    const defaults = Object.fromEntries(ADVANCED_FIELDS.map((field) => [field, (options[field] || []).at(-1)]).filter(([, v]) => v));
    setForm((f) => ({ ...f, accessLevel, ...defaults, codexNetworkAccess: false }));
  }

  const isCodex = form.provider === "codex";
  const isGemini = form.provider === "gemini";
  const isClaude = !isCodex && !isGemini;
  const providerOptions = PROVIDERS.map((p) => ({
    value: p,
    label: providerAvailability[p] ? t(`agents.provider.${p}`) : t("agents.provider.notFound", { name: t(`agents.provider.${p}`) }),
    disabled: !providerAvailability[p],
  }));
  const modelOptions = ((isCodex ? meta?.codexModels : isGemini ? meta?.geminiModels : meta?.models) || []).map((m) => ({
    value: m.value,
    label: m.label,
  }));

  const toolOptions = (meta?.tools || []).map((tool) => {
    const renamed = RENAMED_TOOLS[tool];
    return {
      value: tool,
      label: renamed ? t(renamed.labelKey) : tool,
      title: renamed ? t(renamed.titleKey) : undefined,
    };
  });

  async function handleSave() {
    setError("");
    setSaving(true);
    try {
      if (isNew) await api.createAgent(form);
      else await api.updateAgent(id, form);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  const title = isNew ? t("agents.form.create") : t("agents.form.edit", { name: form.name || "..." });

  if (loading) {
    return (
      <div className="tab-content detail-page">
        <div className="flow-desc">{t("detail.loading")}</div>
      </div>
    );
  }

  const advanced = isCodex ? (
    <>
      <Select
        label={t("agents.codexSandbox")}
        value={form.codexSandbox}
        onChange={(e) => setForm({ ...form, codexSandbox: e.target.value, codexNetworkAccess: false })}
        options={(levelOptions.codexSandbox || []).map((m) => ({ value: m, label: m }))}
      />
      {form.accessLevel === "full" && form.codexSandbox === "workspace-write" && (
        <CheckboxField
          id="codexNetworkAccess"
          checked={form.codexNetworkAccess}
          onChange={(checked) => setForm((f) => ({ ...f, codexNetworkAccess: checked }))}
          label={t("agents.codexNetworkAccess")}
        />
      )}
    </>
  ) : isGemini ? (
    <Select
      label={t("agents.agyMode")}
      value={form.agyMode}
      onChange={(e) => setForm({ ...form, agyMode: e.target.value })}
      options={(levelOptions.agyMode || []).map((m) => ({ value: m, label: t(`agents.agyMode.${m}`) }))}
    />
  ) : (
    <Select
      label={t("agents.permissionMode")}
      value={form.permissionMode}
      onChange={(e) => setForm({ ...form, permissionMode: e.target.value })}
      options={(levelOptions.permissionMode || []).map((m) => ({ value: m, label: m }))}
    />
  );

  return (
    <DetailPage
      breadcrumbs={[
        { label: t("nav.agents"), to: "/agents" },
        { label: isNew ? t("agents.form.create") : form.name || "..." },
      ]}
      title={title}
      subtitle={t("nav.agents.desc")}
      error={error}
      saving={saving}
      onSave={handleSave}
      onCancel={() => navigate("/agents")}
    >
      <DetailSection title={t("detail.section.general")}>
        <DetailFieldGrid>
          <TextInput label={t("agents.name")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          <Select
            label={t("agents.provider")}
            value={form.provider}
            onChange={(e) => setForm({ ...form, provider: e.target.value, model: "" })}
            options={providerOptions}
          />
        </DetailFieldGrid>
        <HelperText>{t("agents.provider.hint")}</HelperText>
        {!providerAvailability[form.provider] && (
          <ErrorBox>{t("agents.provider.unavailableWarning", { name: t(`agents.provider.${form.provider}`) })}</ErrorBox>
        )}
        <DetailFieldGrid>
          <Select label={t("agents.model")} value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} options={modelOptions} />
        </DetailFieldGrid>
        <TextInput
          label={t("agents.description")}
          full
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </DetailSection>

      <DetailSection title={t("detail.section.permissions")} description={t("agents.access.sectionHint")}>
        <Select
          label={t("agents.access")}
          value={form.accessLevel}
          onChange={(e) => setAccessLevel(e.target.value)}
          options={ACCESS_LEVELS.map((level) => ({ value: level, label: t(`agents.access.${level}`) }))}
        />
        <HelperText>{t(`agents.access.${form.accessLevel}.desc.${form.provider}`)}</HelperText>
        <details className="advanced-settings">
          <summary>{t("agents.access.advanced")}</summary>
          <div className="advanced-settings-body">
            {advanced}
            <HelperText>{t("agents.access.advancedHint")}</HelperText>
          </div>
        </details>
      </DetailSection>

      {isClaude && (
        <DetailSection title={t("detail.section.tools")}>
          <DetailField label={t("agents.toolPermissions")} full>
            <ToolPermissionSelect options={toolOptions} allowed={form.allowedTools} onChange={(allowedTools) => setForm((f) => ({ ...f, allowedTools }))} />
          </DetailField>
          <HelperText>{t("agents.toolPermissions.hint")}</HelperText>
          {form.allowedTools.includes(SUBAGENT_TOOL) && <HelperText>{t("agents.tool.subagent.enabled")}</HelperText>}
        </DetailSection>
      )}

      <DetailSection title={t("detail.section.skills")}>
        <Textarea
          label={t("agents.privateSkill")}
          full
          value={form.appendSystemPrompt}
          onChange={(e) => setForm({ ...form, appendSystemPrompt: e.target.value })}
          placeholder={t("agents.privateSkill.placeholder")}
        />
        <DetailField label={t("agents.sharedSkills")} full>
          <ChipSelect
            nameStyle
            options={skills.map((s) => ({ value: s.id, label: s.name, title: s.description }))}
            selected={form.skillIds}
            onChange={(skillIds) => setForm((f) => ({ ...f, skillIds }))}
            emptyMessage={t("agents.noSkills")}
          />
        </DetailField>
        {!isClaude ? (
          <HelperText>{t(isGemini ? "agents.geminiSkillsHint" : "agents.codexSkillsHint")}</HelperText>
        ) : (
          <DetailField label={t("agents.plugins")} full>
            <ChipSelect
              nameStyle
              options={plugins.map((p) => ({ value: p.id, label: p.name, title: p.description }))}
              selected={form.pluginIds}
              onChange={(pluginIds) => setForm((f) => ({ ...f, pluginIds }))}
              emptyMessage={t("agents.noPlugins")}
            />
          </DetailField>
        )}
      </DetailSection>
    </DetailPage>
  );
}
