import React, { useEffect, useState } from "react";
import { api } from "../../../shared/api.js";
import { usePreferences } from "../../../app/PreferencesContext.jsx";
import { DetailField } from "../../../shared/components/DetailLayout.jsx";
import { Select, TextInput } from "../../../shared/components/Input.jsx";
import { HelperText } from "../../../shared/components/Feedback.jsx";
import CheckboxField from "../../../shared/components/CheckboxField.jsx";
import ChipSelect from "../../../shared/components/ChipSelect.jsx";
import { useOpenRouterModels } from "../../../shared/useOpenRouterModels.js";

const PROVIDERS = ["claude", "codex", "gemini", "opencode"];

export const BLANK_SPAWN_POLICY = {
  enabled: false,
  providers: [],
  claudeModels: [],
  codexModels: [],
  geminiModels: [],
  opencodeModels: [],
  maxAgents: 5,
  tokenBudget: 500000,
  // The most access a spawned agent may get in this team; read unless the owner raises it.
  maxAccessLevel: "read",
};

/**
 * A Team's spawn_agent setting (see server/spawn-policy.js): which providers/models its
 * coordinator may create agents with, the per-run limits, and the most access a spawned agent may
 * get (maxAccessLevel, the team's ceiling for ad-hoc spawns and blueprints alike).
 */
export default function SpawnPolicyFields({ id, value, onChange, enabledLabel, hint }) {
  const { t } = usePreferences();
  const [meta, setMeta] = useState(null);
  useEffect(() => {
    api.meta().then(setMeta);
  }, []);

  const spawn = { ...BLANK_SPAWN_POLICY, ...(value || {}) };
  const set = (patch) => onChange({ ...spawn, ...patch });
  const named = (list = []) => list.filter((m) => m.value).map((m) => ({ value: m.value, label: m.label }));
  const availability = meta?.providerAvailability || {};
  // OpenCode spawns run on the default connection, so its models are the ones offered.
  const [modelFilter, setModelFilter] = useState("");
  const openRouter = useOpenRouterModels("default", spawn.enabled && spawn.providers.includes("opencode"));
  const filterText = modelFilter.trim().toLowerCase();
  const openRouterOptions = openRouter.models
    .filter((m) => m.tools !== false)
    .filter((m) => !filterText || spawn.opencodeModels.includes(m.value) || `${m.value} ${m.label}`.toLowerCase().includes(filterText))
    .map((m) => ({ value: m.value, label: m.label, title: m.value }));

  return (
    <>
      <CheckboxField id={id} checked={spawn.enabled} onChange={(enabled) => set({ enabled })} label={enabledLabel} hint={hint} />
      {spawn.enabled && (
        <>
          <DetailField label={t("agents.spawn.providers")} hint={t("agents.spawn.modelsHint")} full>
            <ChipSelect
              options={PROVIDERS.map((p) => ({
                value: p,
                label: availability[p] === false ? t("agents.provider.notFound", { name: t(`agents.provider.${p}`) }) : t(`agents.provider.${p}`),
              }))}
              selected={spawn.providers}
              onChange={(providers) => set({ providers })}
            />
          </DetailField>
          {spawn.providers.includes("claude") && (
            <>
              <DetailField label={t("agents.spawn.claudeModels")} full>
                <ChipSelect options={named(meta?.models)} selected={spawn.claudeModels} onChange={(claudeModels) => set({ claudeModels })} />
              </DetailField>
            </>
          )}
          {spawn.providers.includes("codex") && (
            <>
              <DetailField label={t("agents.spawn.codexModels")} full>
                <ChipSelect
                  options={named(meta?.codexModels)}
                  selected={spawn.codexModels}
                  onChange={(codexModels) => set({ codexModels })}
                  emptyMessage={t("agents.spawn.noCodexModels")}
                />
              </DetailField>
            </>
          )}
          {spawn.providers.includes("gemini") && (
            <>
              <DetailField label={t("agents.spawn.geminiModels")} full>
                <ChipSelect options={named(meta?.geminiModels)} selected={spawn.geminiModels} onChange={(geminiModels) => set({ geminiModels })} />
              </DetailField>
            </>
          )}
          {spawn.providers.includes("opencode") && (
            <>
              <TextInput
                label={t("agents.model.filter")}
                value={modelFilter}
                placeholder={t("agents.model.filter.placeholder")}
                onChange={(e) => setModelFilter(e.target.value)}
              />
              <DetailField label={t("agents.spawn.opencodeModels")} hint={t("agents.model.toolsHint")} full>
                <ChipSelect
                  options={openRouterOptions}
                  selected={spawn.opencodeModels}
                  onChange={(opencodeModels) => set({ opencodeModels })}
                  emptyMessage={openRouter.loading ? t("agents.model.loading") : openRouter.error || t("agents.connection.none")}
                />
              </DetailField>
            </>
          )}
          <Select
            label={t("agents.spawn.maxAccessLevel")}
            value={spawn.maxAccessLevel}
            options={["read", "write", "full"].map((level) => ({ value: level, label: t(`agents.access.${level}`) }))}
            onChange={(e) => set({ maxAccessLevel: e.target.value })}
            hint={t("agents.spawn.ceilingHint")}
          />
          {/* How many and how many tokens live with the run's other limits (WorkflowLimits). */}
          <HelperText>{t("agents.spawn.limitsMoved")}</HelperText>
        </>
      )}
    </>
  );
}
