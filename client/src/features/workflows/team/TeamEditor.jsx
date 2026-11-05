import React, { useEffect, useState } from "react";
import { api } from "../../../shared/api.js";
import { IconClose } from "../../../shared/Icons.jsx";
import TeamDiagram from "./TeamDiagram.jsx";
import { usePreferences } from "../../../app/PreferencesContext.jsx";
import { Button, Select, Textarea, TextInput, HelperText } from "../../../shared/components/index.js";
import SpawnPolicyFields from "./SpawnPolicyFields.jsx";
import MemberAgentList from "./MemberAgentList.jsx";
import BlueprintEditor, { BLANK_BLUEPRINT } from "./BlueprintEditor.jsx";

/** A member's agents in order; a team saved with a single agentId reads as a one-item list. */
export function memberAgentIds(member) {
  return member.agentIds || (member.agentId ? [member.agentId] : []);
}

/**
 * Team workflow editor: a hub diagram on the left (coordinator on top, members hanging below it,
 * a "+ member" card and the spawn_agent card), and an edit panel on the right for whichever card
 * is selected — the same two-column shape as the Pipeline editor, so both types feel alike.
 *
 * Selection is "coordinator", "spawn", a member's index (members have no stable id until they
 * get an alias, and the alias itself is editable), or "bp:<index>" for a blueprint. Members are
 * optional: a team may run on blueprints alone, its coordinator spawning what the job needs.
 */
/** What the diagram says when the team has no fixed members, after how its coordinator gets its agents. */
function noMembersHint(spawn, blueprints) {
  // Every agent it could create is read-only: the run can't change any code to Accept.
  if (spawn?.enabled && (spawn.maxAccessLevel || "read") === "read") return "workflows.team.readOnlySpawn";
  if (spawn?.enabled && spawn.providers?.length) return "workflows.team.noMembersDynamic";
  if (spawn?.enabled && blueprints.length) return "workflows.team.noMembersBlueprints";
  return "workflows.team.noMembers";
}

export default function TeamEditor({ team, agents, onChange }) {
  const { t } = usePreferences();
  const [selected, setSelected] = useState("coordinator");
  const [skills, setSkills] = useState([]);
  const [meta, setMeta] = useState(null);
  useEffect(() => {
    api.listSkills().then((d) => setSkills(d.skills));
    api.meta().then(setMeta);
  }, []);
  const blueprints = team.blueprints || [];

  const agentOptions = agents.map((a) => ({ value: a.id, label: a.name }));
  const update = (patch) => onChange({ ...team, ...patch });
  const updateCoordinator = (patch) => update({ coordinator: { ...team.coordinator, ...patch } });
  const updateMember = (index, patch) => update({ members: team.members.map((m, i) => (i === index ? { ...m, ...patch } : m)) });

  function addMember() {
    update({ members: [...team.members, { alias: "", agentIds: agents[0] ? [agents[0].id] : [], role: "" }] });
    setSelected(team.members.length);
  }

  function removeMember(index) {
    update({ members: team.members.filter((_, i) => i !== index) });
    setSelected("coordinator");
  }

  // A blueprint is only used while spawn_agent is on, so adding one turns it on.
  function addBlueprint() {
    update({ blueprints: [...blueprints, structuredClone(BLANK_BLUEPRINT)], spawnPolicy: { ...team.spawnPolicy, enabled: true } });
    setSelected(`bp:${blueprints.length}`);
  }

  function removeBlueprint(index) {
    update({ blueprints: blueprints.filter((_, i) => i !== index) });
    setSelected("coordinator");
  }

  const updateBlueprint = (index, next) => update({ blueprints: blueprints.map((b, i) => (i === index ? next : b)) });

  const member = typeof selected === "number" ? team.members[selected] : null;
  const blueprintIndex = typeof selected === "string" && selected.startsWith("bp:") ? Number(selected.slice(3)) : -1;
  const blueprint = blueprintIndex >= 0 ? blueprints[blueprintIndex] : null;

  const diagram = (
    <TeamDiagram
      coordinator={{ agentId: team.coordinator.agentId }}
      members={team.members.map((m, i) => ({ key: i, ...m, agentId: memberAgentIds(m)[0] }))}
      spawn={team.spawnPolicy}
      agents={agents}
      selected={selected}
      onSelect={setSelected}
      onAddMember={addMember}
      addLabel={t("workflows.team.addMember")}
      blueprints={blueprints.map((b, i) => ({ key: `bp:${i}`, ...b }))}
      onAddBlueprint={addBlueprint}
      addBlueprintLabel={t("workflows.blueprint.add")}
      hint={!team.members.length ? t(noMembersHint(team.spawnPolicy, blueprints)) : null}
    />
  );

  let panelTitle;
  let panelBody;
  let panelAction = null;
  if (blueprint) {
    panelTitle = blueprint.name || t("workflows.blueprint.unnamed");
    panelAction = (
      <Button variant="icon" color="danger" onClick={() => removeBlueprint(blueprintIndex)} title={t("workflows.blueprint.remove")}>
        <IconClose size={12} />
      </Button>
    );
    panelBody = (
      <>
        {!team.spawnPolicy?.enabled && <HelperText>{t("workflows.blueprint.spawnOff")}</HelperText>}
        <BlueprintEditor
          blueprint={blueprint}
          maxAccessLevel={team.spawnPolicy?.maxAccessLevel || "read"}
          skills={skills}
          meta={meta}
          onChange={(next) => updateBlueprint(blueprintIndex, next)}
        />
      </>
    );
  } else if (selected === "spawn") {
    panelTitle = t("workflows.team.spawnCard");
    panelBody = (
      <>
        {team.spawnPolicy?.enabled && (team.spawnPolicy.maxAccessLevel || "read") === "read" && (
          <HelperText>{t("workflows.team.readOnlySpawn")}</HelperText>
        )}
        <SpawnPolicyFields
          id="teamSpawnEnabled"
          value={team.spawnPolicy}
          onChange={(spawnPolicy) => update({ spawnPolicy })}
          enabledLabel={t("workflows.team.spawn.enabled")}
          hint={t("workflows.team.spawn.hint")}
        />
      </>
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
          hint={t("workflows.team.aliasHint")}
        />
        <MemberAgentList agentIds={memberAgentIds(member)} agents={agents} onChange={(agentIds) => updateMember(selected, { agentIds })} />
        <Textarea
          label={t("workflows.team.role")}
          value={member.role}
          placeholder={t("workflows.team.role.placeholder")}
          onChange={(e) => updateMember(selected, { role: e.target.value })}
          hint={t("workflows.team.roleHint")}
        />
      </>
    );
  } else {
    panelTitle = t("workflows.team.coordinator");
    panelBody = (
      <>
        <Select
          label={t("workflows.team.coordinatorAgent")}
          hint={t("workflows.team.coordinatorHint")}
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
          hint={t("workflows.team.processHint")}
        />
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
