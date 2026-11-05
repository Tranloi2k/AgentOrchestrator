import React, { useEffect, useState } from "react";
import { api } from "../../../shared/api.js";
import { usePreferences } from "../../../app/PreferencesContext.jsx";
import { DetailField, DetailFieldGrid } from "../../../shared/components/DetailLayout.jsx";
import { Select, TextInput } from "../../../shared/components/Input.jsx";
import CheckboxField from "../../../shared/components/CheckboxField.jsx";
import ChipSelect from "../../../shared/components/ChipSelect.jsx";

const PROVIDERS = ["claude", "codex", "gemini"];

export const BLANK_SPAWN_POLICY = {
  enabled: false,
  providers: [],
  claudeModels: [],
  codexModels: [],
  geminiModels: [],
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
          <Select
            label={t("agents.spawn.maxAccessLevel")}
            value={spawn.maxAccessLevel}
            options={["read", "write", "full"].map((level) => ({ value: level, label: t(`agents.access.${level}`) }))}
            onChange={(e) => set({ maxAccessLevel: e.target.value })}
            hint={t("agents.spawn.ceilingHint")}
          />
          <DetailFieldGrid>
            <TextInput
              type="number"
              min={1}
              max={50}
              label={t("agents.spawn.maxAgents")}
              hint={t("agents.spawn.limitsHint")}
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
        </>
      )}
    </>
  );
}
