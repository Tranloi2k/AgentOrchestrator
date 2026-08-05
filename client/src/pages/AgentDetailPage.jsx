import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { usePreferences } from "../PreferencesContext.jsx";
import DetailPage, { DetailSection, DetailField, DetailFieldGrid } from "../components/DetailPage.jsx";
import { TextInput, Select, Textarea, CheckboxField, ChipSelect, HelperText, ErrorBox } from "../components/index.js";

const PERMISSION_MODES = ["acceptEdits", "plan", "auto", "bypassPermissions", "manual", "dontAsk"];

// Claude Code's sub-agent tool is literally named "Task" in the CLI — meaningless in a UI that
// already calls every workflow step a task, so it gets a plain-language label + tooltip. Every
// other tool keeps its real name (Read/Edit/Bash... are self-explanatory).
const SUBAGENT_TOOL = "Task";
const RENAMED_TOOLS = {
  [SUBAGENT_TOOL]: { labelKey: "agents.tool.subagent", titleKey: "agents.tool.subagent.desc" },
};

const BLANK = {
  name: "",
  description: "",
  provider: "claude",
  model: "",
  readOnly: false,
  permissionMode: "acceptEdits",
  allowedTools: [],
  disallowedTools: [],
  codexSandbox: "workspace-write",
  codexNetworkAccess: false,
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
  const [models, setModels] = useState([]);
  const [tools, setTools] = useState([]);
  const [skills, setSkills] = useState([]);
  const [plugins, setPlugins] = useState([]);
  const [codexSandboxModes, setCodexSandboxModes] = useState([]);
  const [codexModels, setCodexModels] = useState([]);
  const [providerAvailability, setProviderAvailability] = useState({ claude: true, codex: true });
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.meta().then((d) => {
      setModels(d.models);
      setTools(d.tools);
      setCodexSandboxModes(d.codexSandboxModes || []);
      setCodexModels(d.codexModels || []);
      if (d.providerAvailability) setProviderAvailability(d.providerAvailability);
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
          disallowedTools: Array.isArray(agent.disallowedTools) ? agent.disallowedTools : [],
          skillIds: Array.isArray(agent.skillIds) ? agent.skillIds : [],
          pluginIds: Array.isArray(agent.pluginIds) ? agent.pluginIds : [],
        });
      } else setError("Agent not found");
      setLoading(false);
    });
  }, [id, isNew]);

  function handleReadOnlyToggle(checked) {
    setForm((f) => ({
      ...f,
      readOnly: checked,
      permissionMode: checked ? "plan" : "acceptEdits",
      disallowedTools: checked ? Array.from(new Set([...f.disallowedTools, "Edit", "Write"])) : f.disallowedTools,
      codexSandbox: checked ? "read-only" : "workspace-write",
    }));
  }

  const isCodex = form.provider === "codex";

  const toolOptions = tools.map((tool) => {
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
          <TextInput
            label={t("agents.name")}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <Select
            label={t("agents.provider")}
            value={form.provider}
            onChange={(e) => setForm({ ...form, provider: e.target.value })}
            options={[
              {
                value: "claude",
                label: providerAvailability.claude ? t("agents.provider.claude") : t("agents.provider.notFound", { name: t("agents.provider.claude") }),
                disabled: !providerAvailability.claude,
              },
              {
                value: "codex",
                label: providerAvailability.codex ? t("agents.provider.codex") : t("agents.provider.notFound", { name: t("agents.provider.codex") }),
                disabled: !providerAvailability.codex,
              },
            ]}
          />
        </DetailFieldGrid>
        <HelperText>{t("agents.provider.hint")}</HelperText>
        {!providerAvailability[form.provider] && (
          <ErrorBox>{t("agents.provider.unavailableWarning", { name: t(isCodex ? "agents.provider.codex" : "agents.provider.claude") })}</ErrorBox>
        )}
        <DetailFieldGrid>
          {isCodex ? (
            <Select
              label={t("agents.model")}
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              options={codexModels.map((m) => ({ value: m.value, label: m.label }))}
            />
          ) : (
            <Select
              label={t("agents.model")}
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              options={models.map((m) => ({ value: m.value, label: m.label }))}
            />
          )}
        </DetailFieldGrid>
        <TextInput
          label={t("agents.description")}
          full
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </DetailSection>

      <DetailSection title={t("detail.section.permissions")}>
        <CheckboxField
          id="readOnly"
          checked={form.readOnly}
          onChange={handleReadOnlyToggle}
          label={t("agents.readOnly")}
        />
        {isCodex ? (
          <>
            <Select
              label={t("agents.codexSandbox")}
              value={form.codexSandbox}
              onChange={(e) => setForm({ ...form, codexSandbox: e.target.value })}
              options={codexSandboxModes.map((m) => ({ value: m, label: m }))}
            />
            {form.codexSandbox === "workspace-write" && (
              <CheckboxField
                id="codexNetworkAccess"
                checked={form.codexNetworkAccess}
                onChange={(checked) => setForm((f) => ({ ...f, codexNetworkAccess: checked }))}
                label={t("agents.codexNetworkAccess")}
              />
            )}
          </>
        ) : (
          <Select
            label={t("agents.permissionMode")}
            value={form.permissionMode}
            onChange={(e) => setForm({ ...form, permissionMode: e.target.value })}
            options={PERMISSION_MODES.map((m) => ({ value: m, label: m }))}
          />
        )}
      </DetailSection>

      {!isCodex && (
        <DetailSection title={t("detail.section.tools")}>
          <DetailField label={t("agents.allowedTools")} full>
            <ChipSelect
              options={toolOptions}
              selected={form.allowedTools}
              onChange={(allowedTools) => setForm((f) => ({ ...f, allowedTools }))}
            />
          </DetailField>
          {form.allowedTools.includes(SUBAGENT_TOOL) && <HelperText>{t("agents.tool.subagent.enabled")}</HelperText>}
          <DetailField label={t("agents.disallowedTools")} full>
            <ChipSelect
              options={toolOptions}
              selected={form.disallowedTools}
              onChange={(disallowedTools) => setForm((f) => ({ ...f, disallowedTools }))}
            />
          </DetailField>
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
        {!isCodex && (
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
