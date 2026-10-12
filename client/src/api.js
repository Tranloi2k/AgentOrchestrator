async function json(res) {
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const d = await res.json();
      if (d?.error) msg = d.error;
    } catch {
      /* ignore */
    }
    throw new Error(msg);
  }
  return res.json();
}

export const api = {
  meta: () => fetch("/api/meta").then(json),
  browseDirs: (path) => fetch(`/api/browse-dirs?path=${encodeURIComponent(path || "")}`).then(json),

  listAgents: () => fetch("/api/agents").then(json),
  createAgent: (data) =>
    fetch("/api/agents", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then(json),
  updateAgent: (id, data) =>
    fetch(`/api/agents/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then(json),
  deleteAgent: (id) => fetch(`/api/agents/${id}`, { method: "DELETE" }).then(json),
  duplicateAgent: (id) => fetch(`/api/agents/${id}/duplicate`, { method: "POST" }).then(json),

  listSkills: () => fetch("/api/skills").then(json),
  createSkill: (data) =>
    fetch("/api/skills", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then(json),
  updateSkill: (id, data) =>
    fetch(`/api/skills/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then(
      json
    ),
  deleteSkill: (id) => fetch(`/api/skills/${id}`, { method: "DELETE" }).then(json),

  listPlugins: () => fetch("/api/plugins").then(json),
  createPlugin: (data) =>
    fetch("/api/plugins", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then(json),
  updatePlugin: (id, data) =>
    fetch(`/api/plugins/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then(
      json
    ),
  deletePlugin: (id) => fetch(`/api/plugins/${id}`, { method: "DELETE" }).then(json),

  listWorkflows: () => fetch("/api/workflows").then(json),
  createWorkflow: (data) =>
    fetch("/api/workflows", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then(json),
  updateWorkflow: (id, data) =>
    fetch(`/api/workflows/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then(
      json
    ),
  deleteWorkflow: (id) => fetch(`/api/workflows/${id}`, { method: "DELETE" }).then(json),

  getUsage: () => fetch("/api/usage").then(json),

  listRuns: () => fetch("/api/runs").then(json),
  getRun: (id) => fetch(`/api/runs/${id}`).then(json),
  deleteRun: (id) => fetch(`/api/runs/${id}`, { method: "DELETE" }).then(json),
  clearRuns: () => fetch("/api/runs", { method: "DELETE" }).then(json),
  stopRun: (id) => fetch(`/api/runs/${id}/stop`, { method: "POST" }).then(json),
  resumeRun: (id) => fetch(`/api/runs/${id}/resume`, { method: "POST" }).then(json),
  acceptRunReview: (id) => fetch(`/api/runs/${id}/review/accept`, { method: "POST" }).then(json),
  declineRunReview: (id) => fetch(`/api/runs/${id}/review/decline`, { method: "POST" }).then(json),
  runAgent: (data) =>
    fetch("/api/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then(json),
  runWorkflow: (data) =>
    fetch("/api/run-workflow", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then(
      json
    ),
};
