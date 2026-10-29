import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../../shared/api.js";
import WorkflowCanvas from "./WorkflowCanvas.jsx";
import WorkflowRunSettings from "./WorkflowRunSettings.jsx";
import TeamEditor from "./team/TeamEditor.jsx";
import { IconClose, IconCopy } from "../../shared/Icons.jsx";
import { usePreferences } from "../../app/PreferencesContext.jsx";
import DetailPage, { DetailSection, DetailFieldGrid } from "../../shared/components/DetailPage.jsx";
import {
  TextInput,
  Select,
  Textarea,
  Button,
  TabBar,
  CheckboxField,
  ChipSelect,
  HelperText,
} from "../../shared/components/index.js";
import { BLANK_SPAWN_POLICY } from "./team/SpawnPolicyFields.jsx";

const BLANK_TEAM = {
  coordinator: { agentId: "", process: "" },
  members: [],
  spawnPolicy: BLANK_SPAWN_POLICY,
};

const BLANK = {
  name: "",
  description: "",
  type: null, // picked once, when the workflow is created
  nodes: [],
  edges: [],
  team: BLANK_TEAM,
  isolation: { enabled: false, testCommand: "", keepOnFailure: true },
  inputs: [],
  limits: { timeoutMin: 0, tokenBudget: 0 },
  schedules: [],
};

const WORKFLOW_TYPES = ["pipeline", "team"];
const COORDINATOR_NODE_ID = "coordinator";

// "General" (agent, node type, prompt) is always visible; these are the per-node extras.
const PANEL_TABS = ["trigger", "branches", "reliability", "callees"];

function newId() {
  return "n" + Math.random().toString(36).slice(2, 8);
}

/** Server validation errors → readable lines. Node ids in params become names the user knows. */
function formatErrors(errors, { t, nodeLabel }) {
  return errors.map((e) => {
    const p = { ...(e.params || {}) };
    for (const key of ["node", "from", "to", "target", "callee"]) if (p[key] !== undefined) p[key] = nodeLabel(p[key]);
    if (Array.isArray(p.nodes)) p.nodes = p.nodes.map(nodeLabel).join(" → ");
    const key = `workflows.err.${e.code}`;
    const msg = t(key, p);
    return msg === key ? e.code : msg;
  });
}

export default function WorkflowDetailPage() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const { t } = usePreferences();
  const [form, setForm] = useState(BLANK);
  const [agents, setAgents] = useState([]);
  const [loading, setLoading] = useState(!isNew);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [errorList, setErrorList] = useState([]);
  const [selected, setSelected] = useState(null);
  const [branchTarget, setBranchTarget] = useState("__new__");
  const [panelTab, setPanelTab] = useState("trigger");
  const [idCopied, setIdCopied] = useState(false);

  useEffect(() => {
    api.listAgents().then((d) => setAgents(d.agents));
    if (isNew) return;
    api.listWorkflows().then((d) => {
      const workflow = d.workflows.find((w) => w.id === id);
      if (workflow) {
        setForm({
          ...BLANK,
          ...workflow,
          type: workflow.type || "pipeline",
          team: { ...BLANK_TEAM, ...(workflow.team || {}) },
        });
      } else setError("Workflow not found");
      setLoading(false);
    });
  }, [id, isNew]);

  const agentName = (aid) => agents.find((a) => a.id === aid)?.name || t("workflows.notSelected");
  const agentProvider = (aid) => agents.find((a) => a.id === aid)?.provider || "claude";
  const agentOptions = agents.map((a) => ({ value: a.id, label: a.name }));

  /** ---- pipeline editing ---- */

  function selectNode(nodeId) {
    setSelected(nodeId);
    setPanelTab("trigger");
    setIdCopied(false);
  }

  async function copyNodeId(nodeId) {
    try {
      await navigator.clipboard.writeText(nodeId);
    } catch {
      // Fallback for older browsers / insecure context
      const el = document.createElement("textarea");
      el.value = nodeId;
      el.setAttribute("readonly", "");
      el.style.position = "absolute";
      el.style.left = "-9999px";
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
    setIdCopied(true);
    window.setTimeout(() => setIdCopied(false), 1500);
  }

  const blankNode = () => ({ id: newId(), agentId: agents[0]?.id || "", promptTemplate: "", kind: "agent", calleeNodeIds: [], autoStart: true });

  function addRootNode() {
    const node = blankNode();
    setForm((f) => ({ ...f, nodes: [...f.nodes, node] }));
    selectNode(node.id);
  }

  function addChildNode(fromId) {
    const node = blankNode();
    const edge = { id: newId(), from: fromId, to: node.id, condition: "" };
    setForm((f) => ({ ...f, nodes: [...f.nodes, node], edges: [...f.edges, edge] }));
    selectNode(node.id);
  }

  function moveNode(nodeId, x, y) {
    setForm((f) => ({ ...f, nodes: f.nodes.map((n) => (n.id === nodeId ? { ...n, x, y } : n)) }));
  }

  function addEdgeToExisting(fromId, toId) {
    if (!toId || toId === fromId) return;
    setForm((f) => ({ ...f, edges: [...f.edges, { id: newId(), from: fromId, to: toId, condition: "" }] }));
  }

  function updateNode(nodeId, patch) {
    setForm((f) => ({ ...f, nodes: f.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) }));
  }

  /** Branch labels only mean something on a router, so turning one back into a plain agent clears them. */
  function setNodeKind(nodeId, kind) {
    setForm((f) => ({
      ...f,
      nodes: f.nodes.map((n) => (n.id === nodeId ? { ...n, kind } : n)),
      edges: kind === "router" ? f.edges : f.edges.map((e) => (e.from === nodeId ? { ...e, condition: "" } : e)),
    }));
  }

  function updateEdge(edgeId, patch) {
    setForm((f) => ({ ...f, edges: f.edges.map((e) => (e.id === edgeId ? { ...e, ...patch } : e)) }));
  }

  function removeEdge(edgeId) {
    setForm((f) => ({ ...f, edges: f.edges.filter((e) => e.id !== edgeId) }));
  }

  function removeNode(nodeId) {
    setForm((f) => ({
      ...f,
      nodes: f.nodes
        .filter((n) => n.id !== nodeId)
        .map((n) => ({ ...n, calleeNodeIds: (n.calleeNodeIds || []).filter((c) => c !== nodeId) })),
      edges: f.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
    }));
    setSelected((s) => (s === nodeId ? null : s));
  }

  /** ---- team editing ---- */

  const team = form.team || BLANK_TEAM;
  const updateTeam = (patch) => setForm((f) => ({ ...f, team: { ...BLANK_TEAM, ...f.team, ...patch } }));

  /** ---- shared ---- */

  function updateIsolation(patch) {
    setForm((f) => ({ ...f, isolation: { ...BLANK.isolation, ...f.isolation, ...patch } }));
  }

  /** How errors and diagrams name a node: team members by alias, everything else by agent. */
  function nodeLabel(nodeId) {
    if (form.type === "team") {
      if (nodeId === COORDINATOR_NODE_ID) return t("workflows.team.coordinatorShort");
      return nodeId;
    }
    const node = form.nodes.find((n) => n.id === nodeId);
    return node ? `${agentName(node.agentId)} (${nodeId})` : nodeId;
  }

  async function handleSave() {
    setError("");
    setErrorList([]);
    setSaving(true);
    try {
      if (isNew) await api.createWorkflow(form);
      else await api.updateWorkflow(id, form);
      return true;
    } catch (err) {
      if (err.errors?.length) {
        setError(t("workflows.errors.title"));
        setErrorList(formatErrors(err.errors, { t, nodeLabel }));
      } else setError(err.message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  const title = isNew ? t("workflows.form.create") : t("workflows.form.edit", { name: form.name || "..." });
  const selectedNode = selected ? form.nodes.find((n) => n.id === selected) : null;
  const outgoingEdges = selectedNode ? form.edges.filter((e) => e.from === selectedNode.id) : [];
  const otherNodes = selectedNode ? form.nodes.filter((n) => n.id !== selectedNode.id) : [];
  const callEdges = form.nodes.flatMap((n) => (n.calleeNodeIds || []).map((to) => ({ from: n.id, to })));
  const isolation = form.isolation || BLANK.isolation;

  if (loading) {
    return <div className="tab-content detail-page"><div className="flow-desc">{t("detail.loading")}</div></div>;
  }

  const errorBox = error ? (
    errorList.length ? (
      <>
        {error}
        <ul className="workflow-error-list">
          {errorList.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </>
    ) : (
      error
    )
  ) : null;

  const generalSection = (
    <DetailSection title={t("detail.section.general")}>
      <DetailFieldGrid>
        <TextInput label={t("workflows.name")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <TextInput
          label={t("workflows.description")}
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
        />
      </DetailFieldGrid>
      {form.type && (
        <HelperText>
          {t("workflows.type.label")}: <strong>{t(`workflows.type.${form.type}`)}</strong> — {t("workflows.type.locked")}
        </HelperText>
      )}
    </DetailSection>
  );

  const typePicker = (
    <DetailSection title={t("workflows.type.choose")}>
      <div className="workflow-type-picker">
        {WORKFLOW_TYPES.map((type) => (
          <button key={type} type="button" className="workflow-type-option" onClick={() => setForm((f) => ({ ...f, type }))}>
            <span className="workflow-type-option-title">{t(`workflows.type.${type}`)}</span>
            <span className="workflow-type-option-desc">{t(`workflows.type.${type}.desc`)}</span>
          </button>
        ))}
      </div>
    </DetailSection>
  );

  const isolationSection = (
    <DetailSection title={t("detail.section.isolation")} description={t("workflows.isolationHint")}>
      <CheckboxField
        id="isolationEnabled"
        checked={!!isolation.enabled}
        onChange={(checked) => updateIsolation({ enabled: checked })}
        label={t("workflows.isolation.enabled")}
        hint={isolation.enabled ? t("workflows.isolation.enabledHint") : ""}
      />
      {isolation.enabled && (
        <>
          <TextInput
            label={t("workflows.isolation.testCommand")}
            placeholder={t("workflows.isolation.testCommand.placeholder")}
            value={isolation.testCommand || ""}
            onChange={(e) => updateIsolation({ testCommand: e.target.value })}
          />
          <HelperText>{t("workflows.isolation.testCommandHint")}</HelperText>
          <CheckboxField
            id="isolationKeepOnFailure"
            checked={isolation.keepOnFailure !== false}
            onChange={(checked) => updateIsolation({ keepOnFailure: checked })}
            label={t("workflows.isolation.keepOnFailure")}
            hint={t("workflows.isolation.keepOnFailureHint")}
          />
          <HelperText>{t("workflows.isolation.caveat")}</HelperText>
        </>
      )}
    </DetailSection>
  );

  const pipelineEditor = (
    <DetailSection title={t("detail.section.steps")} description={t("workflows.stepsGraphHint")}>
      <div className="workflow-editor-layout">
        <WorkflowCanvas
          nodes={form.nodes.map((n) => ({
            id: n.id,
            title: agentName(n.agentId),
            subtitle: n.kind === "router" ? t("kind.router") : n.autoStart === false ? t("workflows.manualBadge") : "",
            kind: n.kind,
            provider: agentProvider(n.agentId),
            x: n.x,
            y: n.y,
          }))}
          edges={form.edges}
          callEdges={callEdges}
          selectedId={selected}
          onNodeClick={selectNode}
          onNodeMove={moveNode}
          onAddNode={addChildNode}
          onRemoveNode={removeNode}
          onAddRoot={addRootNode}
        />

        {selectedNode ? (
          <div className="step-editor-panel">
            <div className="step-editor-head">
              <div className="step-editor-head-main">
                <span className="step-editor-title">{agentName(selectedNode.agentId)}</span>
                <div className="step-editor-id-row" title={t("workflows.nodeIdHint")}>
                  <code className="step-editor-id">id=&quot;{selectedNode.id}&quot;</code>
                  <Button
                    variant="icon"
                    className={idCopied ? "is-copied" : ""}
                    onClick={() => copyNodeId(selectedNode.id)}
                    title={idCopied ? t("common.copied") : t("common.copy")}
                    aria-label={idCopied ? t("common.copied") : t("common.copy")}
                  >
                    {idCopied ? <span className="step-editor-copied">{t("common.copied")}</span> : <IconCopy size={13} />}
                  </Button>
                </div>
              </div>
              <Button variant="icon" color="danger" onClick={() => removeNode(selectedNode.id)} title={t("workflows.removeStep")}>
                <IconClose size={12} />
              </Button>
            </div>

            <div className="node-panel-body">
              <div className="node-panel-section">
                <Select
                  label={t("workflows.agent")}
                  value={selectedNode.agentId}
                  onChange={(e) => updateNode(selectedNode.id, { agentId: e.target.value })}
                  placeholder={t("workflows.selectAgent")}
                  options={agentOptions}
                />
                <Select
                  label={t("workflows.nodeType")}
                  value={selectedNode.kind === "router" ? "router" : "agent"}
                  onChange={(e) => setNodeKind(selectedNode.id, e.target.value)}
                  options={[
                    { value: "agent", label: t("workflows.nodeType.agent") },
                    { value: "router", label: t("workflows.nodeType.router") },
                  ]}
                />
                {selectedNode.kind === "router" && <HelperText className="node-panel-hint">{t("workflows.routerHint")}</HelperText>}
                <TextInput
                  label={t("workflows.nodeName")}
                  value={selectedNode.name || ""}
                  placeholder={t("workflows.nodeName.placeholder")}
                  onChange={(e) => updateNode(selectedNode.id, { name: e.target.value.toLowerCase().replace(/\s+/g, "-") })}
                />
                <HelperText className="node-panel-hint">
                  {selectedNode.name ? t("workflows.nodeName.hintSet", { ref: `{{nodes.${selectedNode.name}}}` }) : t("workflows.nodeName.hint")}
                </HelperText>
                <Textarea
                  label={t("workflows.stepPrompt")}
                  placeholder={t("workflows.stepPrompt.placeholder")}
                  value={selectedNode.promptTemplate}
                  onChange={(e) => updateNode(selectedNode.id, { promptTemplate: e.target.value })}
                />
              </div>

              <div className="node-panel-options">
                <TabBar
                  active={panelTab}
                  onChange={setPanelTab}
                  tabs={PANEL_TABS.map((tab) => ({
                    id: tab,
                    label: t(`workflows.panelTab.${tab}`),
                    count:
                      tab === "branches"
                        ? outgoingEdges.length
                        : tab === "callees"
                          ? (selectedNode.calleeNodeIds || []).length
                          : tab === "reliability"
                            ? (selectedNode.fallbackAgentIds || []).length + (selectedNode.retries ? 1 : 0)
                            : 0,
                  }))}
                />

                {panelTab === "trigger" && (
                  <div className="node-panel-section node-panel-checks">
                    <CheckboxField
                      id="manualOnly"
                      className="node-panel-check"
                      checked={selectedNode.autoStart === false}
                      onChange={(checked) => updateNode(selectedNode.id, { autoStart: !checked })}
                      label={t("workflows.manualOnly")}
                      hint={selectedNode.autoStart === false ? t("workflows.manualOnlyHint") : ""}
                    />
                  </div>
                )}

                {panelTab === "branches" && (
                  <div className="node-panel-section">
                    <HelperText className="node-panel-hint">
                      {t(selectedNode.kind === "router" ? "workflows.branchesHint.router" : "workflows.branchesHint")}
                    </HelperText>
                    {outgoingEdges.map((e) => (
                      <div key={e.id} className="branch-row">
                        <span className="branch-target">→ {agentName(form.nodes.find((n) => n.id === e.to)?.agentId)}</span>
                        {selectedNode.kind === "router" && (
                          <input
                            type="text"
                            value={e.condition}
                            placeholder={t("workflows.condition.placeholder")}
                            onChange={(ev) => updateEdge(e.id, { condition: ev.target.value })}
                          />
                        )}
                        <label className="branch-loop" title={t("workflows.loop.hint")}>
                          <input type="checkbox" checked={!!e.loop} onChange={(ev) => updateEdge(e.id, { loop: ev.target.checked, maxIterations: e.maxIterations || 3 })} />
                          ↺ {t("workflows.loop")}
                        </label>
                        {e.loop && (
                          <input
                            type="number"
                            className="branch-loop-max"
                            min={1}
                            max={20}
                            value={e.maxIterations || 3}
                            title={t("workflows.loop.max")}
                            onChange={(ev) => updateEdge(e.id, { maxIterations: Number(ev.target.value) })}
                          />
                        )}
                        <Button variant="icon" color="danger" onClick={() => removeEdge(e.id)} title={t("workflows.removeBranch")}>
                          <IconClose size={12} />
                        </Button>
                      </div>
                    ))}
                    {outgoingEdges.some((e) => e.loop) && <HelperText className="node-panel-hint">{t("workflows.loop.hint")}</HelperText>}
                    {!outgoingEdges.length && <HelperText className="node-panel-hint">{t("workflows.noBranches")}</HelperText>}

                    <div className="branch-row branch-row-add">
                      <select value={branchTarget} onChange={(e) => setBranchTarget(e.target.value)}>
                        <option value="__new__">{t("workflows.branch.newNode")}</option>
                        {otherNodes.map((n) => (
                          <option key={n.id} value={n.id}>
                            {t("workflows.branch.connectTo", { name: agentName(n.agentId) })}
                          </option>
                        ))}
                      </select>
                      <Button
                        variant="secondary"
                        onClick={() => {
                          if (branchTarget === "__new__") addChildNode(selectedNode.id);
                          else addEdgeToExisting(selectedNode.id, branchTarget);
                        }}
                      >
                        {t("workflows.addBranch")}
                      </Button>
                    </div>
                  </div>
                )}

                {panelTab === "reliability" && (
                  <div className="node-panel-section">
                    <HelperText className="node-panel-hint">{t("workflows.reliability.hint")}</HelperText>
                    <div className="field-label">{t("workflows.fallbackAgents")}</div>
                    {(selectedNode.fallbackAgentIds || []).map((fid, i) => (
                      <div key={fid} className="branch-row">
                        <span className="branch-target">
                          {i + 1}. {agentName(fid)}
                        </span>
                        <Button
                          variant="icon"
                          color="danger"
                          title={t("common.delete")}
                          onClick={() => updateNode(selectedNode.id, { fallbackAgentIds: selectedNode.fallbackAgentIds.filter((x) => x !== fid) })}
                        >
                          <IconClose size={12} />
                        </Button>
                      </div>
                    ))}
                    <select
                      value=""
                      onChange={(e) =>
                        e.target.value && updateNode(selectedNode.id, { fallbackAgentIds: [...(selectedNode.fallbackAgentIds || []), e.target.value] })
                      }
                    >
                      <option value="">{t("workflows.fallbackAgents.add")}</option>
                      {agentOptions
                        .filter((o) => o.value !== selectedNode.agentId && !(selectedNode.fallbackAgentIds || []).includes(o.value))
                        .map((o) => (
                          <option key={o.value} value={o.value}>
                            {o.label}
                          </option>
                        ))}
                    </select>
                    <DetailFieldGrid>
                      <TextInput
                        type="number"
                        min={0}
                        max={5}
                        label={t("workflows.retries")}
                        value={selectedNode.retries ?? 0}
                        onChange={(e) => updateNode(selectedNode.id, { retries: Number(e.target.value) })}
                      />
                      <TextInput
                        type="number"
                        min={0}
                        max={600}
                        label={t("workflows.retryDelay")}
                        value={selectedNode.retryDelaySec ?? 10}
                        onChange={(e) => updateNode(selectedNode.id, { retryDelaySec: Number(e.target.value) })}
                      />
                      <TextInput
                        type="number"
                        min={0}
                        label={t("workflows.nodeTimeout")}
                        value={selectedNode.timeoutSec ?? 0}
                        onChange={(e) => updateNode(selectedNode.id, { timeoutSec: Number(e.target.value) })}
                      />
                      <TextInput
                        type="number"
                        min={0}
                        step={10000}
                        label={t("workflows.nodeTokenBudget")}
                        value={selectedNode.tokenBudget ?? 0}
                        onChange={(e) => updateNode(selectedNode.id, { tokenBudget: Number(e.target.value) })}
                      />
                    </DetailFieldGrid>
                    <HelperText className="node-panel-hint">{t("workflows.reliability.limitsHint")}</HelperText>
                  </div>
                )}

                {panelTab === "callees" && (
                  <div className="node-panel-section">
                    <HelperText className="node-panel-hint">{t("workflows.calleesHint")}</HelperText>
                    <ChipSelect
                      nameStyle
                      options={otherNodes.map((n) => ({
                        value: n.id,
                        label: `${agentName(n.agentId)} · id="${n.id}"`,
                        title: t("workflows.calleesChipTitle", { name: agentName(n.agentId), id: n.id }),
                      }))}
                      selected={selectedNode.calleeNodeIds || []}
                      onChange={(calleeNodeIds) => updateNode(selectedNode.id, { calleeNodeIds })}
                      emptyMessage={t("workflows.noCallees")}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <div className="step-editor-panel step-editor-placeholder">
            <div className="flow-desc">{t("workflows.selectNodeHint")}</div>
          </div>
        )}
      </div>
      {!form.nodes.length && <div className="workflow-editor-empty-hint flow-desc">{t("workflows.canvasEmpty")}</div>}
    </DetailSection>
  );

  const teamEditor = (
    <DetailSection title={t("workflows.team.section")} description={t("workflows.team.sectionHint")}>
      <TeamEditor team={team} agents={agents} onChange={(next) => updateTeam(next)} />
    </DetailSection>
  );

  return (
    <DetailPage
      breadcrumbs={[
        { label: t("nav.workflows"), to: "/workflows" },
        { label: isNew ? t("workflows.form.create") : form.name || "..." },
      ]}
      title={title}
      subtitle={t("nav.workflows.desc")}
      error={errorBox}
      saving={saving}
      wide
      onSave={handleSave}
      onCancel={() => navigate("/workflows")}
    >
      {!form.type ? (
        typePicker
      ) : (
        <>
          {generalSection}
          {form.type === "team" ? teamEditor : pipelineEditor}
          <WorkflowRunSettings form={form} setForm={setForm} workflowId={isNew ? null : id} />
          {isolationSection}
        </>
      )}
    </DetailPage>
  );
}
