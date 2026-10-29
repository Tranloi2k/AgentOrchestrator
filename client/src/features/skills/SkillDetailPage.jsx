import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../../shared/api.js";
import { usePreferences } from "../../app/PreferencesContext.jsx";
import DetailPage, { DetailSection, DetailFieldGrid } from "../../shared/components/DetailPage.jsx";
import { TextInput, Textarea } from "../../shared/components/index.js";

const BLANK = { name: "", description: "", content: "" };

export default function SkillDetailPage() {
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
    api.listSkills().then((d) => {
      const skill = d.skills.find((s) => s.id === id);
      if (skill) setForm({ ...BLANK, ...skill });
      else setError("Skill not found");
      setLoading(false);
    });
  }, [id, isNew]);

  async function handleSave() {
    setError("");
    setSaving(true);
    try {
      if (isNew) await api.createSkill(form);
      else await api.updateSkill(id, form);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  const title = isNew ? t("skills.form.create") : t("skills.form.edit", { name: form.name || "..." });

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
        { label: t("nav.skills"), to: "/skills" },
        { label: isNew ? t("skills.form.create") : form.name || "..." },
      ]}
      title={title}
      subtitle={t("nav.skills.desc")}
      error={error}
      saving={saving}
      onSave={handleSave}
      onCancel={() => navigate("/skills")}
    >
      <DetailSection title={t("detail.section.general")}>
        <DetailFieldGrid>
          <TextInput
            label={t("skills.name")}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <TextInput
            label={t("skills.shortDesc")}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
            placeholder={t("skills.shortDesc.placeholder")}
          />
        </DetailFieldGrid>
      </DetailSection>

      <DetailSection title={t("detail.section.content")} description={t("skills.content")}>
        <Textarea
          full
          size="lg"
          value={form.content}
          onChange={(e) => setForm({ ...form, content: e.target.value })}
          placeholder={t("skills.content.placeholder")}
        />
      </DetailSection>
    </DetailPage>
  );
}
