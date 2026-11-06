import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../../shared/api.js";
import { usePreferences } from "../../app/PreferencesContext.jsx";
import DetailPage, { DetailSection, DetailField, DetailFieldGrid } from "../../shared/components/DetailPage.jsx";
import { Button, CheckboxField, ErrorBox, HelperText, SegmentedControl, Select, TextInput } from "../../shared/components/index.js";
import { useOpenRouterModels, openRouterModelLabel } from "../../shared/useOpenRouterModels.js";

const BLANK = { name: "", kind: "openrouter", tier: "free", apiKey: "", defaultModel: "", isDefault: false, maskedKey: "" };

export default function ProviderDetailPage() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const { t } = usePreferences();
  const [form, setForm] = useState(BLANK);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  // The saved connection's models (its saved tier decides free-only); none until it exists.
  const openRouter = useOpenRouterModels(id, !isNew);
  const modelOptions = openRouter.models
    .filter((m) => m.tools !== false && (form.tier === "paid" || m.free))
    .map((m) => ({ value: m.value, label: openRouterModelLabel(m, t), title: m.value }));
  if (form.defaultModel && !modelOptions.some((m) => m.value === form.defaultModel)) {
    modelOptions.unshift({ value: form.defaultModel, label: form.defaultModel });
  }

  useEffect(() => {
    if (isNew) {
      // The first connection becomes the default.
      api.listProviders().then((d) => setForm((f) => ({ ...f, isDefault: !d.providers.length })));
      return;
    }
    api.listProviders().then((d) => {
      const provider = d.providers.find((p) => p.id === id);
      // The key never comes back from the server: the field starts empty and an empty one keeps it.
      if (provider) setForm({ ...BLANK, ...provider, apiKey: "" });
      else setError("Provider not found");
      setLoading(false);
    });
  }, [id, isNew]);

  async function handleSave() {
    setError("");
    setSaving(true);
    try {
      const data = { name: form.name, kind: form.kind, tier: form.tier, isDefault: form.isDefault, apiKey: form.apiKey, defaultModel: form.defaultModel };
      if (isNew) await api.createProvider(data);
      else await api.updateProvider(id, data);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.testProvider(id));
    } catch (err) {
      setTestResult({ ok: false, error: err.message });
    } finally {
      setTesting(false);
    }
  }

  const title = isNew ? t("providers.form.create") : t("providers.form.edit", { name: form.name || "..." });

  if (loading) {
    return (
      <div className="tab-content detail-page">
        <div className="flow-desc">{t("detail.loading")}</div>
      </div>
    );
  }

  const money = (v) => (typeof v === "number" ? v.toFixed(4).replace(/\.?0+$/, "") || "0" : "?");

  return (
    <DetailPage
      breadcrumbs={[
        { label: t("nav.providers"), to: "/providers" },
        { label: isNew ? t("providers.form.create") : form.name || "..." },
      ]}
      title={title}
      error={error}
      saving={saving}
      onSave={handleSave}
      onCancel={() => navigate("/providers")}
    >
      <DetailSection title={t("detail.section.general")}>
        <DetailFieldGrid>
          <TextInput
            label={t("providers.name")}
            value={form.name}
            placeholder={t("providers.name.placeholder")}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <DetailField label={t("providers.tier")}>
            <SegmentedControl
              options={[
                { value: "free", label: t("providers.tier.free") },
                { value: "paid", label: t("providers.tier.paid") },
              ]}
              value={form.tier}
              onChange={(tier) => setForm({ ...form, tier })}
            />
          </DetailField>
        </DetailFieldGrid>
        <HelperText>{t(`providers.tier.hint.${form.tier}`)}</HelperText>
        {isNew ? (
          <HelperText>{t("providers.defaultModel.saveFirst")}</HelperText>
        ) : (
          <Select
            label={t("providers.defaultModel")}
            hint={t("providers.defaultModel.hint")}
            full
            value={form.defaultModel}
            onChange={(e) => setForm({ ...form, defaultModel: e.target.value })}
            placeholder={openRouter.loading ? t("agents.model.loading") : t("providers.defaultModel.fallback")}
            options={modelOptions}
          />
        )}
        <ErrorBox>{openRouter.error}</ErrorBox>
      </DetailSection>

      <DetailSection title={t("providers.apiKey")}>
        <DetailField label={t("providers.apiKey")} full>
          <input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={form.apiKey}
            placeholder={isNew ? t("providers.apiKey.placeholder") : t("providers.apiKey.keep", { masked: form.maskedKey })}
            onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
          />
        </DetailField>
        <HelperText>{t("providers.apiKey.hint")}</HelperText>
        <CheckboxField
          id="providerIsDefault"
          checked={form.isDefault}
          onChange={(isDefault) => setForm((f) => ({ ...f, isDefault }))}
          label={t("providers.isDefault")}
          hint={t("providers.isDefault.hint")}
        />
        <div>
          <Button variant="secondary" onClick={handleTest} disabled={isNew || testing}>
            {testing ? t("providers.testing") : t("providers.test")}
          </Button>
        </div>
        {isNew && <HelperText>{t("providers.test.saveFirst")}</HelperText>}
        {testResult?.ok && (
          <HelperText>
            ✅{" "}
            {t("providers.test.ok", {
              label: testResult.label ? ` (${testResult.label})` : "",
              usage: money(testResult.usage),
              limit: testResult.limit == null ? t("providers.test.noLimit") : `$${money(testResult.limit)}`,
              free: testResult.isFreeTier ? t("providers.test.freeTier") : "",
            })}
          </HelperText>
        )}
        {testResult && !testResult.ok && <ErrorBox>{testResult.error}</ErrorBox>}
      </DetailSection>
    </DetailPage>
  );
}
