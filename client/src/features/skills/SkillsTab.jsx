import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../../shared/api.js";
import { IconEdit, IconTrash } from "../../shared/Icons.jsx";
import { usePreferences } from "../../app/PreferencesContext.jsx";
import { Button, ConfirmModal, TabPageHeader } from "../../shared/components/index.js";

export default function SkillsTab() {
  const navigate = useNavigate();
  const { t } = usePreferences();
  const [skills, setSkills] = useState([]);
  const [agents, setAgents] = useState([]);
  const [workflows, setWorkflows] = useState([]);
  const [confirmTarget, setConfirmTarget] = useState(null);
  // What the server said when it refused a delete the list below did not predict.
  const [deleteError, setDeleteError] = useState("");

  function refresh() {
    api.listSkills().then((d) => setSkills(d.skills));
  }

  useEffect(() => {
    refresh();
    api.listAgents().then((d) => setAgents(d.agents));
    api.listWorkflows().then((d) => setWorkflows(d.workflows));
  }, []);

  // Agents, and the blueprints of Teams (shown as "workflow / blueprint"), that use the skill.
  const usedBy = (skillId) => [
    ...agents.filter((a) => a.skillIds?.includes(skillId)).map((a) => a.name),
    ...workflows.flatMap((w) => (w.team?.blueprints || []).filter((b) => b.skillIds?.includes(skillId)).map((b) => `${w.name} / ${b.name}`)),
  ];
  const usedByCount = (skillId) => usedBy(skillId).length;

  async function confirmDelete() {
    const skill = confirmTarget;
    setConfirmTarget(null);
    if (!skill) return;
    try {
      await api.deleteSkill(skill.id);
    } catch (err) {
      setDeleteError(t("skills.deleteFailed", { name: skill.name, error: err.message }));
    }
    refresh();
    api.listAgents().then((d) => setAgents(d.agents));
    api.listWorkflows().then((d) => setWorkflows(d.workflows));
  }

  const blockedNames = confirmTarget ? usedBy(confirmTarget.id) : [];
  const isBlocked = blockedNames.length > 0;

  return (
    <div className="tab-content">
      <TabPageHeader hint={t("skills.banner")} actionLabel={t("skills.create")} onAction={() => navigate("/skills/new")} />

      <div className="entity-table-wrap">
        {skills.length ? (
          <table className="entity-table">
            <colgroup>
              <col style={{ width: "22%" }} />
              <col />
              <col style={{ width: 260 }} />
              <col style={{ width: 96 }} />
            </colgroup>
            <thead>
              <tr>
                <th>{t("list.col.name")}</th>
                <th>{t("list.col.description")}</th>
                <th>{t("list.col.usedBy")}</th>
                <th aria-label={t("list.col.actions")} />
              </tr>
            </thead>
            <tbody>
              {skills.map((s) => (
                <tr key={s.id}>
                  <td title={s.name}>
                    <div className="entity-table-name" onClick={() => navigate(`/skills/${s.id}`)}>
                      <span className="entity-table-name-text">{s.name}</span>
                    </div>
                  </td>
                  <td className="entity-table-desc" title={s.description}>{s.description}</td>
                  <td className="entity-table-meta" title={usedBy(s.id).join(", ")}>
                    {t("skills.usedBy", { count: usedByCount(s.id) })}
                  </td>
                  <td>
                    <div className="entity-table-actions">
                      <Button variant="icon" title={t("common.edit")} aria-label={t("common.edit")} onClick={() => navigate(`/skills/${s.id}`)}>
                        <IconEdit />
                      </Button>
                      <Button variant="icon" color="danger" title={t("common.delete")} aria-label={t("common.delete")} onClick={() => setConfirmTarget(s)}>
                        <IconTrash />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="flow-desc entity-table-empty">{t("skills.empty")}</div>
        )}
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

      {deleteError && (
        <ConfirmModal
          title={t("common.delete")}
          blocked
          reason={deleteError}
          onConfirm={() => setDeleteError("")}
          onClose={() => setDeleteError("")}
        />
      )}
    </div>
  );
}
