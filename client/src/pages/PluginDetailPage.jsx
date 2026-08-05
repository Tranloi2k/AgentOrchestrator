import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { usePreferences } from "../PreferencesContext.jsx";
import DetailPage, { DetailSection, DetailFieldGrid } from "../components/DetailPage.jsx";
import { TextInput, Select } from "../components/index.js";

const BLANK = { name: "", description: "", sourceType: "git", sourceValue: "" };

export default function PluginDetailPage() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const { t } = usePreferences();
  const [form, setForm] = useState(BLANK);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (isNew) return;
    api.listPlugins().then((d) => {
      const plugin = d.plugins.find((p) => p.id === id);
      if (plugin) setForm({ ...BLANK, ...plugin });
      else setError("Plugin not found");
      setLoading(false);
    });
  }, [id, isNew]);

  async function handleSave() {
    setError("");
    setSaving(true);
    try {
      if (isNew) await api.createPlugin(form);
      else await api.updatePlugin(id, { name: form.name, description: form.description });
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  const placeholderKey = `plugins.sourceValue.${form.sourceType}.placeholder`;
  const title = isNew ? t("plugins.form.create") : t("plugins.form.edit", { name: form.name || "..." });

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
        { label: t("nav.plugins"), to: "/plugins" },
        { label: isNew ? t("plugins.form.create") : form.name || "..." },
      ]}
      title={title}
      subtitle={t("nav.plugins.desc")}
      error={error}
      saving={saving}
      saveLabel={saving ? t("plugins.installing") : t("common.save")}
      onSave={handleSave}
      onCancel={() => navigate("/plugins")}
    >
      <DetailSection title={t("detail.section.general")}>
        <DetailFieldGrid>
          <TextInput
            label={t("plugins.name")}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <TextInput
            label={t("plugins.description")}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </DetailFieldGrid>
      </DetailSection>

      {isNew && (
        <DetailSection title={t("detail.section.source")}>
          <DetailFieldGrid>
            <Select
              label={t("plugins.sourceType")}
              value={form.sourceType}
              onChange={(e) => setForm({ ...form, sourceType: e.target.value })}
              options={[
                { value: "git", label: t("plugins.sourceType.git") },
                { value: "dir", label: t("plugins.sourceType.dir") },
                { value: "url", label: t("plugins.sourceType.url") },
              ]}
            />
            <TextInput
              label={t("plugins.sourceValue")}
              value={form.sourceValue}
              onChange={(e) => setForm({ ...form, sourceValue: e.target.value })}
              placeholder={t(placeholderKey)}
            />
          </DetailFieldGrid>
        </DetailSection>
      )}
    </DetailPage>
  );
}
