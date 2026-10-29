import React, { useEffect, useState } from "react";
import { api } from "../../shared/api.js";
import { IconClose } from "../../shared/Icons.jsx";
import { usePreferences } from "../../app/PreferencesContext.jsx";
import { DetailSection, DetailFieldGrid } from "../../shared/components/DetailPage.jsx";
import { Button, CheckboxField, HelperText, TextInput, Textarea } from "../../shared/components/index.js";

const fmt = (ms) => new Date(ms).toLocaleString();

/** Same defaults as DEFAULT_TEAM_LIMITS in server/src/features/workflows/workflow-model.js. */
export const DEFAULT_TEAM_LIMITS = { maxDelegations: 30, callTimeoutMinutes: 30, runTokenBudget: 2_000_000 };

/** Live check of a cron expression: valid or not, and the next times it would fire. */
function CronPreview({ cron }) {
  const { t } = usePreferences();
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    if (!cron.trim()) return setPreview(null);
    const timer = setTimeout(() => api.cronPreview(cron).then(setPreview).catch(() => setPreview(null)), 300);
    return () => clearTimeout(timer);
  }, [cron]);
  if (!preview) return null;
  return preview.ok ? (
    <HelperText>{t("workflows.schedule.next", { times: preview.next.map(fmt).join(" · ") })}</HelperText>
  ) : (
    <HelperText className="text-error">{preview.error}</HelperText>
  );
}

/**
 * Workflow-wide settings for running it: named inputs ({{input.x}}), limits for the whole run, and
 * cron schedules. Shown for both workflow types, under the type's own editor.
 */
export default function WorkflowRunSettings({ form, setForm, workflowId }) {
  const { t } = usePreferences();
  const [status, setStatus] = useState({});
  useEffect(() => {
    if (workflowId) api.scheduleStatus().then((d) => setStatus(d.status || {})).catch(() => {});
  }, [workflowId]);

  const inputs = form.inputs || [];
  const limits = form.limits || { timeoutMin: 0, tokenBudget: 0 };
  const schedules = form.schedules || [];
  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  // A Team's own limits (server: normalizeTeamLimits); a team saved before them gets the defaults.
  const teamLimits = { ...DEFAULT_TEAM_LIMITS, ...(form.team?.limits || {}) };
  const setTeamLimits = (patch) => setForm((f) => ({ ...f, team: { ...f.team, limits: { ...DEFAULT_TEAM_LIMITS, ...(f.team?.limits || {}), ...patch } } }));
  const setInput = (i, patch) => set({ inputs: inputs.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const setSchedule = (i, patch) => set({ schedules: schedules.map((x, j) => (j === i ? { ...x, ...patch } : x)) });

  return (
    <>
      <DetailSection title={t("workflows.inputs")} description={t("workflows.inputs.hint")}>
        {inputs.map((inp, i) => (
          <div key={i} className="settings-row">
            <input
              type="text"
              value={inp.name}
              placeholder={t("workflows.inputs.name")}
              aria-label={t("workflows.inputs.name")}
              onChange={(e) => setInput(i, { name: e.target.value.toLowerCase().replace(/\s+/g, "_") })}
            />
            <input type="text" value={inp.label} placeholder={t("workflows.inputs.label")} aria-label={t("workflows.inputs.label")} onChange={(e) => setInput(i, { label: e.target.value })} />
            <input type="text" value={inp.default} placeholder={t("workflows.inputs.default")} aria-label={t("workflows.inputs.default")} onChange={(e) => setInput(i, { default: e.target.value })} />
            <label className="settings-check">
              <input type="checkbox" checked={!!inp.required} onChange={(e) => setInput(i, { required: e.target.checked })} />
              {t("workflows.inputs.required")}
            </label>
            <Button variant="icon" color="danger" title={t("common.delete")} onClick={() => set({ inputs: inputs.filter((_, j) => j !== i) })}>
              <IconClose size={12} />
            </Button>
          </div>
        ))}
        {inputs.some((i) => i.name) && (
          <HelperText>{t("workflows.inputs.usage", { refs: inputs.filter((i) => i.name).map((i) => `{{input.${i.name}}}`).join(", ") })}</HelperText>
        )}
        <div>
          <Button variant="secondary" onClick={() => set({ inputs: [...inputs, { name: "", label: "", default: "", required: false }] })}>
            {t("workflows.inputs.add")}
          </Button>
        </div>
      </DetailSection>

      <DetailSection title={t("workflows.limits")} description={t("workflows.limits.hint")}>
        <DetailFieldGrid>
          <TextInput
            type="number"
            min={0}
            label={t("workflows.limits.timeout")}
            value={limits.timeoutMin}
            onChange={(e) => set({ limits: { ...limits, timeoutMin: Number(e.target.value) } })}
          />
          {form.type !== "team" && (
            <TextInput
              type="number"
              min={0}
              step={10000}
              label={t("workflows.limits.tokens")}
              value={limits.tokenBudget}
              onChange={(e) => set({ limits: { ...limits, tokenBudget: Number(e.target.value) } })}
            />
          )}
        </DetailFieldGrid>
        {form.type === "team" && (
          <>
            <DetailFieldGrid>
              <TextInput
                type="number"
                min={1}
                label={t("workflows.teamLimits.maxDelegations")}
                value={teamLimits.maxDelegations}
                onChange={(e) => setTeamLimits({ maxDelegations: Number(e.target.value) })}
              />
              <TextInput
                type="number"
                min={1}
                label={t("workflows.teamLimits.callTimeout")}
                value={teamLimits.callTimeoutMinutes}
                onChange={(e) => setTeamLimits({ callTimeoutMinutes: Number(e.target.value) })}
              />
              <TextInput
                type="number"
                min={0}
                step={100000}
                label={t("workflows.teamLimits.tokens")}
                value={teamLimits.runTokenBudget}
                onChange={(e) => setTeamLimits({ runTokenBudget: Number(e.target.value) })}
              />
            </DetailFieldGrid>
            <HelperText>{t("workflows.teamLimits.hint")}</HelperText>
          </>
        )}
      </DetailSection>

      <DetailSection title={t("workflows.schedules")} description={t("workflows.schedules.hint")}>
        {schedules.map((sc, i) => {
          const st = status[sc.id];
          return (
            <div key={sc.id || i} className="schedule-card">
              <div className="schedule-card-head">
                <CheckboxField id={`sc-${i}`} checked={sc.enabled !== false} onChange={(enabled) => setSchedule(i, { enabled })} label={t("workflows.schedule.enabled")} />
                <Button variant="icon" color="danger" title={t("common.delete")} onClick={() => set({ schedules: schedules.filter((_, j) => j !== i) })}>
                  <IconClose size={12} />
                </Button>
              </div>
              <TextInput label={t("workflows.schedule.cron")} value={sc.cron} placeholder="0 7 * * 1-5" onChange={(e) => setSchedule(i, { cron: e.target.value })} />
              <CronPreview cron={sc.cron} />
              <Textarea label={t("workflows.schedule.prompt")} value={sc.prompt} onChange={(e) => setSchedule(i, { prompt: e.target.value })} />
              {inputs.filter((inp) => inp.name).length > 0 && (
                <DetailFieldGrid>
                  {inputs
                    .filter((inp) => inp.name)
                    .map((inp) => (
                      <TextInput
                        key={inp.name}
                        label={`${inp.label || inp.name}${inp.required ? " *" : ""}`}
                        value={sc.inputs?.[inp.name] ?? ""}
                        placeholder={inp.default}
                        onChange={(e) => setSchedule(i, { inputs: { ...(sc.inputs || {}), [inp.name]: e.target.value } })}
                      />
                    ))}
                </DetailFieldGrid>
              )}
              <DetailFieldGrid>
                <TextInput label={t("workflows.schedule.cwd")} value={sc.cwd} placeholder={t("workflows.schedule.cwdDefault")} onChange={(e) => setSchedule(i, { cwd: e.target.value })} />
                <TextInput
                  label={t("workflows.schedule.branch")}
                  value={sc.targetBranch}
                  placeholder={t("workflows.schedule.branchDefault")}
                  onChange={(e) => setSchedule(i, { targetBranch: e.target.value.trim() })}
                />
              </DetailFieldGrid>
              {st && (
                <HelperText>
                  {[
                    st.nextAt && t("workflows.schedule.nextAt", { time: fmt(st.nextAt) }),
                    st.lastFiredAt && t("workflows.schedule.lastAt", { time: fmt(st.lastFiredAt) }),
                    st.lastRunId && `run ${st.lastRunId}`,
                    st.lastSkipped,
                    st.lastError && `❌ ${st.lastError}`,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </HelperText>
              )}
            </div>
          );
        })}
        <div>
          <Button
            variant="secondary"
            onClick={() => set({ schedules: [...schedules, { id: Math.random().toString(36).slice(2, 8), enabled: true, cron: "0 7 * * 1-5", prompt: "", inputs: {}, cwd: "", targetBranch: "" }] })}
          >
            {t("workflows.schedule.add")}
          </Button>
        </div>
      </DetailSection>
    </>
  );
}
