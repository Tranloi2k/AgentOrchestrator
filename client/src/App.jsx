import React from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "./Layout.jsx";
import RunTab from "./RunTab.jsx";
import AgentsTab from "./AgentsTab.jsx";
import SkillsTab from "./SkillsTab.jsx";
import PluginsTab from "./PluginsTab.jsx";
import WorkflowsTab from "./WorkflowsTab.jsx";
import AgentDetailPage from "./pages/AgentDetailPage.jsx";
import SkillDetailPage from "./pages/SkillDetailPage.jsx";
import PluginDetailPage from "./pages/PluginDetailPage.jsx";
import WorkflowDetailPage from "./pages/WorkflowDetailPage.jsx";
import DocsPage from "./pages/DocsPage.jsx";

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route path="/" element={<Navigate to="/run" replace />} />
        <Route path="/run" element={<RunTab />} />
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
        <Route path="/docs" element={<DocsPage />} />
        <Route path="*" element={<Navigate to="/run" replace />} />
      </Route>
    </Routes>
  );
}
