import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../shared/api.js";
import { usePreferences } from "../../app/PreferencesContext.jsx";
import { Button, ConfirmModal, FormActions, InfoBanner, TabPageHeader } from "../../shared/components/index.js";

export default function SkillsTab() {
  const navigate = useNavigate();
  const { t } = usePreferences();
  const [skills, setSkills] = useState([]);
  const [agents, setAgents] = useState([]);
  const [confirmTarget, setConfirmTarget] = useState(null);

  function refresh() {
    api.listSkills().then((d) => setSkills(d.skills));
  }

  useEffect(() => {
    refresh();
    api.listAgents().then((d) => setAgents(d.agents));
  }, []);

  const usedBy = (skillId) => agents.filter((a) => a.skillIds?.includes(skillId));
  const usedByCount = (skillId) => usedBy(skillId).length;

  async function confirmDelete() {
    const skill = confirmTarget;
    setConfirmTarget(null);
    if (!skill) return;
    await api.deleteSkill(skill.id);
    refresh();
    api.listAgents().then((d) => setAgents(d.agents));
  }

  const blockedNames = confirmTarget ? usedBy(confirmTarget.id).map((a) => a.name) : [];
  const isBlocked = blockedNames.length > 0;

  return (
    <div className="tab-content">
      <TabPageHeader title={t("skills.title")} actionLabel={t("skills.create")} onAction={() => navigate("/skills/new")} />
      <InfoBanner>{t("skills.banner")}</InfoBanner>

      <div className="card-grid">
        {skills.map((s) => (
          <div key={s.id} className="entity-card">
            <div className="entity-card-title">{s.name}</div>
            <div className="entity-card-desc">{s.description}</div>
            <div className="entity-card-meta">{t("skills.usedBy", { count: usedByCount(s.id) })}</div>
            <FormActions>
              <Button variant="secondary" onClick={() => navigate(`/skills/${s.id}`)}>
                {t("common.edit")}
              </Button>
              <Button variant="secondary" color="danger" onClick={() => setConfirmTarget(s)}>
                {t("common.delete")}
              </Button>
            </FormActions>
          </div>
        ))}
        {!skills.length && <div className="flow-desc">{t("skills.empty")}</div>}
      </div>

      {confirmTarget && (
        <ConfirmModal
          title={t("common.delete")}
          message={t("skills.confirmDelete", { name: confirmTarget.name })}
          blocked={isBlocked}
          reason={isBlocked ? t("skills.deleteBlocked", { name: confirmTarget.name, names: blockedNames.join(", ") }) : ""}
          onConfirm={confirmDelete}
          onClose={() => setConfirmTarget(null)}
        />
      )}
    </div>
  );
}
