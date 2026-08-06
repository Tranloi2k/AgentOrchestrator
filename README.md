# Agents Orchestrator

Run Claude Code and Codex as coordinated agents from a web UI, using the CLI logins you already have.

You set up agents in the browser, wire them into a workflow graph, and hit run. The server spawns a real child process per agent, either `claude -p` or `codex exec`, and streams the output back over a WebSocket. There's no field to paste an API key anywhere, because nothing needs one. Each subprocess inherits whatever session the CLI is already signed into, so a Claude Code subscription or a ChatGPT plan with the Codex CLI is enough.

## What's in it

Agents are presets: which CLI runs them, which model, what they're allowed to touch, and any instructions you want attached. Skills are reusable instruction blocks you write once and hang off as many agents as you like. Plugins are actual Claude Code plugins, cloned from Git or pointed at a local folder.

Workflows are a node graph rather than a linear chain, so branches can run in parallel, several branches can merge back into one node, a router node can pick a single branch based on its own answer, and agents can call each other mid-run and wait for the reply.

Runs stream live to the browser and get written to disk, so the full per-task log is still there after a restart.

Internals are written up in [`docs/orchestrator-notes.md`](docs/orchestrator-notes.md), and the app has a Docs tab that covers workflow setup step by step in Vietnamese and English.

## Requirements

Node 18 or newer, plus at least one of these CLIs installed and logged in:

- Claude Code. Install from the official docs, then run `claude` once, or `claude auth login`. Check with `claude --version`.
- Codex CLI. `npm install -g @openai/codex`, then `codex login`. Check with `codex --version`.

At startup the server probes for both. Whichever one is missing gets disabled in the agent provider dropdown with a warning, so you can't build an agent that's guaranteed to fail. If you install a CLI later, restart the server so it gets picked up.

## Install and run

```bash
npm install
npm run dev
```

It's an npm workspaces monorepo, so one install covers `server/` and `client/`. The UI comes up on http://localhost:5173 and proxies `/api` and `/ws` through to the API server on port 5175. Open it, type a prompt, pick an agent or a workflow, and click Run.

Other scripts:

```bash
npm run dev:server    # API only
npm run dev:client    # UI only
npm run build:client  # production build into client/dist
npm run start         # API server only, does not serve the built client
```

### Working directory

Agents run in the server's own working directory unless you say otherwise. Set it globally with an env var:

```bash
TARGET_DIR="C:\path\to\your\repo" npm run dev
```

Or set it per run in the UI, which has a folder browser so you don't have to type paths.

## Project layout

```
AgentOrchestrator/
├── client/                 # React + Vite UI
│   ├── src/
│   └── public/             # favicon, provider icons
├── server/
│   ├── index.js            # Express API + WebSocket
│   ├── orchestrator.js     # agents, workflows, run execution
│   ├── mcp-bridge.js       # the ask_agent MCP tool (Claude only)
│   ├── agents.config.json
│   ├── skills.config.json
│   ├── plugins.config.json
│   ├── workflows.config.json
│   └── runs.json           # run history, written by the server
└── docs/
```

## Agents

The field that matters most is the provider, labelled "Runs on" in the form. It decides whether the agent runs through `claude -p` or `codex exec`, and the rest of the form changes to match.

For Claude Code agents you get a model picker, a permission mode, and per-tool allow and deny lists. One entry in that tool list is worth calling out: "Spawn sub-agents" is Claude Code's `Task` tool under a friendlier name, since "task" already means something else in an app full of workflow steps. Tick it and the agent can create its own general-purpose sub-agents to work parts of a job in parallel. Ticking it is the whole setup, because the server appends usage guidance to the system prompt when the tool is allowed, so the agent works out for itself when delegating is worth it. Their output lands in the parent's log via `--forward-subagent-text` instead of collapsing into a summary. You can also give the agent a private system prompt, attach shared skills, and attach plugins.

Codex agents look different because `codex exec` exposes less. The model dropdown is read from `~/.codex/models_cache.json`, which the CLI writes at login, so it always lists what your account can actually run and never goes stale. Permissions come down to a sandbox mode (`read-only`, `workspace-write`, or `danger-full-access`) plus a network access toggle that only applies in `workspace-write`. There are no per-tool lists, no plugins, and no `ask_agent`.

The read-only switch picks safe defaults for whichever provider you're on: `plan` mode with Edit and Write blocked for Claude, a `read-only` sandbox for Codex.

Deleting an agent that a workflow still references is refused, and the error names the workflows so you know where to look. Duplicate and delete both go through a confirmation dialog.

## Skills

Reusable instructions, like commit message conventions or house rules for a project. Write one, attach it to as many agents as you want.

For Claude agents the content goes in through `--append-system-prompt`. Codex has no equivalent flag, so it gets prepended to the prompt instead. Deleting a skill that agents still use is refused, same as with agents.

## Plugins

Real Claude Code plugins, the kind with a `.claude-plugin/plugin.json`, not a reimplementation. You can point at a Git repo (cloned into `server/plugins/<id>/`), a directory you already have locally, or a `.zip` URL. Claude Code agents only.

## Workflows

The graph supports a few things a straight chain can't:

Multiple outgoing edges from a node run at the same time. Multiple incoming edges make a merge node that waits for all of them. A router node compares its own output against a condition label on each outgoing edge and takes exactly one branch, marking the rest skipped so they never spend a token.

Two-way calls are the interesting one. A node can call another node's agent while it's still running, block until the answer comes back, then carry on with it. That's what lets a project manager agent hand work to an engineer, wait for real code, pass it to a reviewer, and decide from the review whether to loop back. Nodes marked manual-only (`autoStart: false`) sit out the normal graph traversal entirely and run only when something calls them this way.

Every node carries its own id, something like `nwvl6e3`, shown on the canvas and in the node panel with a copy button. That id, not the agent id from the Agents tab, is what `ask_agent` takes.

## Run history

Runs live in `server/runs.json` along with per-task logs and results, and they survive a restart. Writes are throttled to roughly one every 400ms so a chatty log stream doesn't hammer the disk.

If the server dies mid-run, the child process dies with it and there's no way to resume, so on the next startup anything still marked running gets flipped to error with a note explaining what happened. Whatever it had already logged is kept.

You can delete runs one at a time (hover for the trash icon) or clear the lot. Both ask first. Deleting a run that's still going is refused, and clear-all just skips those rather than failing outright.

Navigating to another tab doesn't stop anything. Execution is server side and doesn't care whether a browser is watching. Come back to the Run tab and click the run to pick the log back up.

## Auto-decompose

On a single agent run you can turn this on to have a read-only Claude planner split your prompt into a JSON array of subtasks first. Those then run one after another with the agent you picked. Sequential on purpose, since parallel agents writing into the same repo tend to trip over each other.

## Limitations

Local, single user, no auth. There's no way to stop a run once it's going, which is the gap that bothers me most.

Codex agents can't use `ask_agent`, since the MCP bridge is Claude only. They work fine as ordinary workflow nodes. Codex also has no per-tool permissions, just the sandbox and network flags, because that's all the CLI offers.

Agents writing to the same repo in parallel can conflict. A `git worktree` per agent would fix it properly and isn't built yet.

`npm run start` only brings up the API. It doesn't serve the built client, so for anything beyond `npm run dev` you'd need to host `client/dist` yourself.

## Configuration files

| File | Contents |
|------|----------|
| `server/agents.config.json` | Agent definitions |
| `server/skills.config.json` | Shared skills |
| `server/plugins.config.json` | Installed plugin registry |
| `server/workflows.config.json` | Workflow graphs |
| `server/runs.json` | Run history, managed by the server |

The UI writes all of these, so editing them by hand is optional. If you do edit one directly, restart the server: they're read into memory once at startup, and a running server won't notice the change.

## License

MIT. See [LICENSE](LICENSE).
