# Agents Orchestrator

A local multi-agent orchestrator with a web UI. You enter one prompt, and the server spawns **real CLI processes** for each agent — either **`claude -p`** (Claude Code) or **`codex exec`** (Codex CLI), depending on the provider you assign to that agent. The UI shows workflow graphs, live logs, and run history streamed over WebSocket.

**No API keys required.** The system uses your existing local CLI login (Claude Code subscription or Codex CLI signed in via ChatGPT). It never stores or asks for API keys.

## Features

- **Agents** — configure name, provider, model, tools, private skills, shared skills, and Claude Code plugins
- **Skills** — reusable instruction libraries attached to multiple agents
- **Plugins** — real Claude Code plugins (Git clone, local folder, or `.zip` URL)
- **Workflows** — node graph editor with parallel branches, merge points, router nodes, and two-way `ask_agent` calls
- **Run tab** — launch a single agent or a full workflow; optional auto-decompose into subtasks
- **Run history** — persisted to disk; survives server restarts
- **UI** — Vietnamese / English, light / dark theme, confirmation modals, success feedback on save

For deeper internals, see [`docs/orchestrator-notes.md`](docs/orchestrator-notes.md).

## Requirements

- **Node.js** ≥ 18
- At least one of these CLIs installed and logged in:
  - **Claude Code** — install from the official docs, then run `claude` once or `claude auth login`. Check with `claude --version`.
  - **Codex CLI** — `npm install -g @openai/codex`, then `codex login`. Check with `codex --version`.

On startup the server probes which CLIs are available (`claude --version` / `codex --version`). Missing CLIs are disabled in the agent provider dropdown with a warning. Install a CLI later and **restart the server** to re-detect it.

## Install

```bash
npm install
```

This is an npm workspaces monorepo — one install covers both `server/` and `client/`.

## Run (development)

```bash
npm run dev
```

| Service | URL |
|---------|-----|
| UI (Vite, proxies `/api` and `/ws` to the server) | http://localhost:5173 |
| API + WebSocket | http://localhost:5175 |

Open http://localhost:5173, enter a prompt, pick an agent or workflow, and click **Run**.

### Working directory

By default agents run in the server process working directory (`process.cwd()`). Override globally:

```bash
TARGET_DIR="C:\path\to\your\repo" npm run dev
```

Or set **Working directory** per run in the UI (with a built-in folder browser).

### Other scripts

```bash
npm run dev:server   # API only
npm run dev:client   # UI only
npm run build:client # production build → client/dist
npm run start        # start API server only (no static UI)
```

## Project layout

```
AgentOrchestrator/
├── client/                 # React + Vite UI
│   ├── src/
│   └── public/             # favicon, provider icons
├── server/
│   ├── index.js            # Express API + WebSocket
│   ├── orchestrator.js     # core: agents, workflows, runs
│   ├── mcp-bridge.js       # ask_agent MCP tool (Claude only)
│   ├── agents.config.json
│   ├── skills.config.json
│   ├── plugins.config.json
│   ├── workflows.config.json
│   └── runs.json           # run history (auto-managed)
└── docs/
```

## Managing agents, skills, plugins, and workflows

Everything is editable from the UI — you do not need to hand-edit JSON (though the server reads those files on startup).

### Agents

The most important field is **Runs on** (provider): `Claude Code` or `Codex`.

**Claude Code**

- Model (Sonnet / Opus / Haiku / Fable / default)
- Permission mode, allowed / disallowed tools
- **Spawn sub-agents** — a tool in that same list (Claude Code's `Task` tool, shown under a plainer name). Tick it and the agent may create its own general-purpose sub-agents to parallelize parts of a job, then combine their results. Ticking it is the entire setup: the server injects the usage guidance into the system prompt at run time, so the agent decides for itself when to delegate — nothing to repeat in the prompt. Sub-agent output is streamed into that step's log via `--forward-subagent-text`.
- Private skill (per-agent system prompt)
- Shared skills from the Skills library
- Real Claude Code plugins from the Plugins tab

**Codex**

- Model dropdown is read from `~/.codex/models_cache.json` (whatever your Codex CLI fetched at login — not hardcoded)
- Permissions are limited to what `codex exec` supports:
  - **Sandbox**: `read-only` / `workspace-write` / `danger-full-access`
  - **Network access in sandbox** (only when sandbox = `workspace-write`)
- No per-tool allow/deny lists, no plugins, and **no `ask_agent`** support (see limitations)

**Read-only** mode sets safe defaults for both providers (Claude: `plan` + no Edit/Write; Codex: `read-only` sandbox).

**Delete protection** — deleting an agent referenced by a workflow is blocked with the workflow name(s). **Duplicate** and **delete** both use in-app confirmation modals.

### Skills

Reusable instructions (e.g. commit conventions, project rules). Attach to any number of agents.

- Claude: content is appended via `--append-system-prompt`
- Codex: content is prepended to the prompt (no equivalent flag)

Deleting a skill still in use by agents is blocked.

### Plugins

Real Claude Code plugins (with `.claude-plugin/plugin.json`), not emulated. Three source types:

1. Git repo (auto `git clone` into `server/plugins/<id>/`)
2. Local directory
3. `.zip` URL

Claude Code agents only.

### Workflows

A **node graph**, not just a linear chain:

- **Parallel branches** — multiple outgoing edges run concurrently
- **Merge** — a node waits for all incoming branches
- **Router** — matches the node's output against edge conditions to pick exactly one branch
- **Two-way calls (`ask_agent`)** — while running, a node can call another node's agent, block until it answers, then continue
- **Manual-only nodes** (`autoStart: false`) — only run when called via `ask_agent`, not when the workflow starts

Each workflow node has its **own id** (e.g. `id="nwvl6e3"`), shown on the canvas and in the node detail panel. This is the id to pass to `ask_agent` — **not** the agent's id from the Agents tab. The node panel includes a one-click copy button.

The in-app **Docs** tab (`/docs`) walks through all of this in detail (Vietnamese and English).

## Run history

Runs are stored in `server/runs.json` and **survive server restarts**, including per-task logs and results. Writes are throttled (~400 ms) to avoid excessive disk I/O during streaming.

- If the server crashes mid-run, the next startup marks that run as **error** with an explanation (the CLI child is gone; logs up to that point are kept)
- Delete individual runs (hover → trash) or **Clear all** — both require confirmation
- Deleting a **running** run is refused; clear-all silently skips active runs
- Navigating away in the UI does **not** stop a run — execution is server-side. Return to the Run tab and click the run in history to view live logs

## Auto-decompose mode

When enabled on a single-agent run, the server spawns a read-only Claude "planner" that splits your prompt into a JSON array of subtasks, then runs them **sequentially** with the selected agent (sequential to reduce file conflicts in the same repo).

## Current limitations

- **Local single-user only** — no auth or multi-tenant support
- **No stop/cancel** for a run in progress
- **Codex** cannot use `ask_agent` (Claude-only MCP bridge); Codex nodes still work via normal workflow edges
- **Codex** has no per-tool allow/deny — only sandbox + network flags
- Parallel agents editing the same repo can conflict; consider separate `git worktree` directories per agent
- Dev setup serves UI and API separately; `npm run start` does not serve the built client (use `npm run dev` or add your own static hosting)

## Configuration files

| File | Purpose |
|------|---------|
| `server/agents.config.json` | Agent definitions |
| `server/skills.config.json` | Shared skills |
| `server/plugins.config.json` | Plugin registry |
| `server/workflows.config.json` | Workflow graphs |
| `server/runs.json` | Run history (managed by the server) |

Edit via UI or directly; restart is not required for config changes during a running server (API reads/writes these files on each request).

## License

MIT. See [LICENSE](LICENSE).
