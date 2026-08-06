import React, { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import WorkflowCanvas from "../WorkflowCanvas.jsx";
import { IconClose, IconCopy } from "../Icons.jsx";
import { usePreferences } from "../PreferencesContext.jsx";
import DetailPage, { DetailSection, DetailFieldGrid } from "../components/DetailPage.jsx";
import {
  TextInput,
  Select,
  Textarea,
  Button,
  TabBar,
  CheckboxField,
  ChipSelect,
  HelperText,
} from "../components/index.js";

const BLANK = {
  name: "",
  description: "",
  nodes: [],
  edges: [],
  isolation: { enabled: false, testCommand: "", keepOnFailure: true },
};

// "General" (agent + prompt) is always visible, not a switchable tab — it's the one thing
// you need for every node, not an optional/advanced setting like the three below.
const PANEL_TABS = ["trigger", "branches", "callees"];

function newId() {
  return "n" + Math.random().toString(36).slice(2, 8);
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
  const [selected, setSelected] = useState(null);
  const [branchTarget, setBranchTarget] = useState("__new__");
  const [panelTab, setPanelTab] = useState("trigger");
  const [idCopied, setIdCopied] = useState(false);

  useEffect(() => {
    api.listAgents().then((d) => setAgents(d.agents));
    if (isNew) return;
    api.listWorkflows().then((d) => {
      const workflow = d.workflows.find((w) => w.id === id);
      if (workflow) setForm({ ...BLANK, ...workflow });
      else setError("Workflow not found");
      setLoading(false);
    });
  }, [id, isNew]);

  function selectNode(nodeId) {
    setSelected(nodeId);
    setPanelTab("trigger");
    setIdCopied(false);
  }

  async function copyNodeId(nodeId) {
    try {
      await navigator.clipboard.writeText(nodeId);
      setIdCopied(true);
      window.setTimeout(() => setIdCopied(false), 1500);
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
      setIdCopied(true);
      window.setTimeout(() => setIdCopied(false), 1500);
    }
  }

  function addRootNode() {
    const node = { id: newId(), agentId: agents[0]?.id || "", promptTemplate: "", kind: "agent", calleeNodeIds: [], autoStart: true };
    setForm((f) => ({ ...f, nodes: [...f.nodes, node] }));
    selectNode(node.id);
  }

  function addChildNode(fromId) {
    const node = { id: newId(), agentId: agents[0]?.id || "", promptTemplate: "", kind: "agent", calleeNodeIds: [], autoStart: true };
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

  function updateIsolation(patch) {
    setForm((f) => ({ ...f, isolation: { ...BLANK.isolation, ...f.isolation, ...patch } }));
  }

  function updateNode(nodeId, patch) {
    setForm((f) => ({ ...f, nodes: f.nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n)) }));
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
      nodes: f.nodes.filter((n) => n.id !== nodeId),
      edges: f.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
    }));
    setSelected((s) => (s === nodeId ? null : s));
  }

  async function handleSave() {
    setError("");
    const hasRoot = form.nodes.some((n) => n.autoStart !== false && !form.edges.some((e) => e.to === n.id));
    if (!form.nodes.length || form.nodes.some((n) => !n.agentId) || !hasRoot) {
      setError(t("workflows.validation"));
      return false;
    }
    setSaving(true);
    try {
      if (isNew) await api.createWorkflow(form);
      else await api.updateWorkflow(id, form);
      return true;
    } catch (err) {
      setError(err.message);
      return false;
    } finally {
      setSaving(false);
    }
  }

  const title = isNew ? t("workflows.form.create") : t("workflows.form.edit", { name: form.name || "..." });
  const agentName = (aid) => agents.find((a) => a.id === aid)?.name || t("workflows.notSelected");
  const agentProvider = (aid) => agents.find((a) => a.id === aid)?.provider || "claude";
  const selectedNode = selected ? form.nodes.find((n) => n.id === selected) : null;
  const outgoingEdges = selectedNode ? form.edges.filter((e) => e.from === selectedNode.id) : [];
  const otherNodes = selectedNode ? form.nodes.filter((n) => n.id !== selectedNode.id) : [];
  const callEdges = form.nodes.flatMap((n) => (n.calleeNodeIds || []).map((to) => ({ from: n.id, to })));
  const isolation = form.isolation || BLANK.isolation;

  if (loading) {
    return <div className="tab-content detail-page"><div className="flow-desc">{t("detail.loading")}</div></div>;
  }

  return (
    <DetailPage
      breadcrumbs={[
        { label: t("nav.workflows"), to: "/workflows" },
        { label: isNew ? t("workflows.form.create") : form.name || "..." },
      ]}
      title={title}
      subtitle={t("nav.workflows.desc")}
      error={error}
      saving={saving}
      wide
      onSave={handleSave}
      onCancel={() => navigate("/workflows")}
    >
      <DetailSection title={t("detail.section.general")}>
        <DetailFieldGrid>
          <TextInput
            label={t("workflows.name")}
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
          <TextInput
            label={t("workflows.description")}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </DetailFieldGrid>
      </DetailSection>

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
                  {/* Node id for ask_agent — chip + copy button; full hint lives in title. */}
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
                <Button
                  variant="icon"
                  color="danger"
                  onClick={() => removeNode(selectedNode.id)}
                  title={t("workflows.removeStep")}
                >
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
                    options={agents.map((a) => ({ value: a.id, label: a.name }))}
                  />
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
                            : 0,
                    }))}
                  />

                  {panelTab === "trigger" && (
                    <div className="node-panel-section node-panel-checks">
                      <CheckboxField
                        id="isRouter"
                        className="node-panel-check"
                        checked={selectedNode.kind === "router"}
                        onChange={(checked) => updateNode(selectedNode.id, { kind: checked ? "router" : "agent" })}
                        label={t("workflows.isRouter")}
                        hint={selectedNode.kind === "router" ? t("workflows.routerHint") : ""}
                      />
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
                      <HelperText className="node-panel-hint">{t("workflows.branchesHint")}</HelperText>
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
                          <Button
                            variant="icon"
                            color="danger"
                            onClick={() => removeEdge(e.id)}
                            title={t("workflows.removeBranch")}
                          >
                            <IconClose size={12} />
                          </Button>
                        </div>
                      ))}
                      {!outgoingEdges.length && (
                        <HelperText className="node-panel-hint">{t("workflows.noBranches")}</HelperText>
                      )}

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

                  {panelTab === "callees" && (
                    <div className="node-panel-section">
                      <HelperText className="node-panel-hint">{t("workflows.calleesHint")}</HelperText>
                      <ChipSelect
                        nameStyle
                        options={otherNodes.map((n) => ({
                          value: n.id,
                          // Node id is shown in the chip itself (not just a tooltip) because it's
                          // exactly what you paste into the caller's prompt when telling it which
                          // id to pass to ask_agent — see workflows.calleesIdHint below.
                          label: `${agentName(n.agentId)} · id="${n.id}"`,
                          title: t("workflows.calleesChipTitle", { name: agentName(n.agentId), id: n.id }),
                        }))}
                        selected={selectedNode.calleeNodeIds || []}
                        onChange={(calleeNodeIds) => updateNode(selectedNode.id, { calleeNodeIds })}
                        emptyMessage={t("workflows.noCallees")}
                      />
                      {!!selectedNode.calleeNodeIds?.length && (
                        <HelperText className="node-panel-hint">{t("workflows.calleesIdHint")}</HelperText>
                      )}
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
    </DetailPage>
  );
}
