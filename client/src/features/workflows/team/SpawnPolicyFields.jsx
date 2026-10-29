import React, { useEffect, useState } from "react";
import { api } from "../../../shared/api.js";
import { usePreferences } from "../../../app/PreferencesContext.jsx";
import { DetailField, DetailFieldGrid } from "../../../shared/components/DetailLayout.jsx";
import { TextInput } from "../../../shared/components/Input.jsx";
import CheckboxField from "../../../shared/components/CheckboxField.jsx";
import ChipSelect from "../../../shared/components/ChipSelect.jsx";
import { HelperText } from "../../../shared/components/Feedback.jsx";

const PROVIDERS = ["claude", "codex", "gemini"];

export const BLANK_SPAWN_POLICY = {
  enabled: false,
  providers: [],
  claudeModels: [],
  codexModels: [],
  geminiModels: [],
  maxAgents: 5,
  tokenBudget: 500000,
};

/**
 * A Team's spawn_agent setting (see server/spawn-policy.js): which providers/models its
 * coordinator may create agents with, and the per-run limits. What a spawned agent may *do* is
 * not set here — it's capped by the coordinator's own access level and tools.
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

  return (
    <>
      <CheckboxField id={id} checked={spawn.enabled} onChange={(enabled) => set({ enabled })} label={enabledLabel} />
      {hint && <HelperText>{hint}</HelperText>}
      {spawn.enabled && (
        <>
          <DetailField label={t("agents.spawn.providers")} full>
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
          <HelperText>{t("agents.spawn.modelsHint")}</HelperText>
          <HelperText>{t("agents.spawn.ceilingHint")}</HelperText>
          <DetailFieldGrid>
            <TextInput
              type="number"
              min={1}
              max={50}
              label={t("agents.spawn.maxAgents")}
              value={spawn.maxAgents}
              onChange={(e) => set({ maxAgents: Number(e.target.value) })}
            />
            <TextInput
              type="number"
              min={0}
              step={10000}
              label={t("agents.spawn.tokenBudget")}
              value={spawn.tokenBudget}
              onChange={(e) => set({ tokenBudget: Number(e.target.value) })}
            />
          </DetailFieldGrid>
          <HelperText>{t("agents.spawn.limitsHint")}</HelperText>
        </>
      )}
    </>
  );
}
