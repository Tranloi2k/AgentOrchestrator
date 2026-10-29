import React from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./Layout.jsx";
import RunTab from "../features/runs/RunTab.jsx";
import AgentsTab from "../features/agents/AgentsTab.jsx";
import SkillsTab from "../features/skills/SkillsTab.jsx";
import PluginsTab from "../features/plugins/PluginsTab.jsx";
import WorkflowsTab from "../features/workflows/WorkflowsTab.jsx";
import UsageTab from "../features/usage/UsageTab.jsx";
import AgentDetailPage from "../features/agents/AgentDetailPage.jsx";
import SkillDetailPage from "../features/skills/SkillDetailPage.jsx";
import PluginDetailPage from "../features/plugins/PluginDetailPage.jsx";
import WorkflowDetailPage from "../features/workflows/WorkflowDetailPage.jsx";
import DocsPage from "../features/docs/DocsPage.jsx";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/run" replace />} />
        <Route path="/run" element={<RunTab view="history" />} />
        <Route path="/run/new" element={<RunTab view="new" />} />
        <Route path="/run/:runId" element={<RunTab view="history" />} />
        <Route path="/agents" element={<AgentsTab />} />
        <Route path="/agents/new" element={<AgentDetailPage />} />
        <Route path="/agents/:id" element={<AgentDetailPage />} />
        <Route path="/skills" element={<SkillsTab />} />
        <Route path="/skills/new" element={<SkillDetailPage />} />
        <Route path="/skills/:id" element={<SkillDetailPage />} />
        <Route path="/plugins" element={<PluginsTab />} />
        <Route path="/plugins/new" element={<PluginDetailPage />} />
        <Route path="/plugins/:id" element={<PluginDetailPage />} />
        <Route path="/workflows" element={<WorkflowsTab />} />
        <Route path="/workflows/new" element={<WorkflowDetailPage />} />
        <Route path="/workflows/:id" element={<WorkflowDetailPage />} />
        <Route path="/usage" element={<UsageTab />} />
        <Route path="/docs" element={<DocsPage />} />
        <Route path="*" element={<Navigate to="/run" replace />} />
      </Route>
    </Routes>
  );
}
