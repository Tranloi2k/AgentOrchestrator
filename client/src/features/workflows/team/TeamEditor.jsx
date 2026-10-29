import React, { useState } from "react";
import { IconClose } from "../../../shared/Icons.jsx";
import TeamDiagram from "./TeamDiagram.jsx";
import { usePreferences } from "../../../app/PreferencesContext.jsx";
import { Button, Select, Textarea, TextInput, HelperText } from "../../../shared/components/index.js";
import SpawnPolicyFields from "./SpawnPolicyFields.jsx";

/**
 * Team workflow editor: a hub diagram on the left (coordinator on top, members hanging below it,
 * a "+ member" card and the spawn_agent card), and an edit panel on the right for whichever card
 * is selected — the same two-column shape as the Pipeline editor, so both types feel alike.
 *
 * Selection is "coordinator", "spawn", or a member's index (members have no stable id until they
 * get an alias, and the alias itself is editable).
 */
export default function TeamEditor({ team, agents, onChange }) {
  const { t } = usePreferences();
  const [selected, setSelected] = useState("coordinator");

  const agentOptions = agents.map((a) => ({ value: a.id, label: a.name }));
  const update = (patch) => onChange({ ...team, ...patch });
  const updateCoordinator = (patch) => update({ coordinator: { ...team.coordinator, ...patch } });
  const updateMember = (index, patch) => update({ members: team.members.map((m, i) => (i === index ? { ...m, ...patch } : m)) });

  function addMember() {
    update({ members: [...team.members, { alias: "", agentId: agents[0]?.id || "", role: "" }] });
    setSelected(team.members.length);
  }

  function removeMember(index) {
    update({ members: team.members.filter((_, i) => i !== index) });
    setSelected("coordinator");
  }

  const member = typeof selected === "number" ? team.members[selected] : null;

  const diagram = (
    <TeamDiagram
      coordinator={{ agentId: team.coordinator.agentId }}
      members={team.members.map((m, i) => ({ key: i, ...m }))}
      spawn={team.spawnPolicy}
      agents={agents}
      selected={selected}
      onSelect={setSelected}
      onAddMember={addMember}
      addLabel={t("workflows.team.addMember")}
      hint={!team.members.length ? t("workflows.team.noMembers") : null}
    />
  );

  let panelTitle;
  let panelBody;
  let panelAction = null;
  if (selected === "spawn") {
    panelTitle = t("workflows.team.spawnCard");
    panelBody = (
      <SpawnPolicyFields
        id="teamSpawnEnabled"
        value={team.spawnPolicy}
        onChange={(spawnPolicy) => update({ spawnPolicy })}
        enabledLabel={t("workflows.team.spawn.enabled")}
        hint={t("workflows.team.spawn.hint")}
      />
    );
  } else if (member) {
    panelTitle = member.alias || t("workflows.team.unnamedMember");
    panelAction = (
      <Button variant="icon" color="danger" onClick={() => removeMember(selected)} title={t("workflows.team.removeMember")}>
        <IconClose size={12} />
      </Button>
    );
    panelBody = (
      <>
        <TextInput
          label={t("workflows.team.alias")}
          value={member.alias}
          placeholder={t("workflows.team.alias.placeholder")}
          onChange={(e) => updateMember(selected, { alias: e.target.value.toLowerCase().replace(/\s+/g, "-") })}
        />
        <HelperText>{t("workflows.team.aliasHint")}</HelperText>
        <Select
          label={t("workflows.agent")}
          value={member.agentId}
          placeholder={t("workflows.selectAgent")}
          onChange={(e) => updateMember(selected, { agentId: e.target.value })}
          options={agentOptions}
        />
        <Textarea
          label={t("workflows.team.role")}
          value={member.role}
          placeholder={t("workflows.team.role.placeholder")}
          onChange={(e) => updateMember(selected, { role: e.target.value })}
        />
        <HelperText>{t("workflows.team.roleHint")}</HelperText>
      </>
    );
  } else {
    panelTitle = t("workflows.team.coordinator");
    panelBody = (
      <>
        <HelperText>{t("workflows.team.coordinatorHint")}</HelperText>
        <Select
          label={t("workflows.team.coordinatorAgent")}
          value={team.coordinator.agentId}
          placeholder={t("workflows.selectAgent")}
          onChange={(e) => updateCoordinator({ agentId: e.target.value })}
          options={agentOptions}
        />
        <Textarea
          label={t("workflows.team.process")}
          size="lg"
          placeholder={t("workflows.team.process.placeholder")}
          value={team.coordinator.process}
          onChange={(e) => updateCoordinator({ process: e.target.value })}
        />
        <HelperText>{t("workflows.team.processHint")}</HelperText>
      </>
    );
  }

  return (
    <div className="workflow-editor-layout">
      {diagram}
      <div className="step-editor-panel">
        <div className="step-editor-head">
          <div className="step-editor-head-main">
            <span className="step-editor-title">{panelTitle}</span>
          </div>
          {panelAction}
        </div>
        <div className="node-panel-body">
          <div className="node-panel-section">{panelBody}</div>
        </div>
      </div>
    </div>
  );
}
