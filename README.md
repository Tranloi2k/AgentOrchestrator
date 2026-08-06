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

Codex agents look different because `codex exec` exposes less. The model dropdown is read from `~/.codex/models_cache.json`, which the CLI writes at login, so it always lists what your account can actually run and never goes stale. Permissions come down to a sandbox mode (`read-only`, `workspace-write`, or `danger-full-access`) plus a network access toggle that only applies in `workspace-write`. There are no per-tool lists and no Claude Code plugins. `ask_agent` and skills, however, work the same as they do for Claude — see below.

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

## The agent bridge

`server/mcp-bridge.js` is a plain stdio MCP server exposing the single `ask_agent` tool, and nothing in it is Claude-specific. Both CLIs run the exact same process; only the flags pointing at it differ, so `buildAgentBridgeContext` produces the environment and `buildClaudeBridgeArgs` / `buildCodexBridgeArgs` wrap it per provider. That means a Codex node can call a Claude node, a Claude node can call a Codex node, and either can call its own kind — all through the same node ids on the canvas, with the same per-node callee permissions and the same `MAX_CALL_DEPTH` guard.

Claude takes the whole server definition as one inline `--mcp-config` JSON blob. Codex has no such flag: it reads MCP servers from `[mcp_servers.<name>]` in `~/.codex/config.toml`, and `-c key=value` overrides any of it per invocation with the value parsed as TOML, so the bridge is passed as a handful of dotted overrides and nothing is written to your real config file.

One of those overrides is load-bearing: `default_tools_approval_mode = "approve"`. Without it `codex exec` treats every MCP tool call as needing approval, and with no TTY to ask there is nobody to say yes, so the call comes back as `user cancelled MCP tool call` and the agent gives up. The valid values are `auto | prompt | writes | approve`, and `auto` is not sufficient. This is set on the `agent-bridge` server only, so it grants nothing beyond `ask_agent` — Codex's own shell and file tools stay behind `--sandbox` exactly as before.

The prompt is fed to `codex exec` on stdin rather than as an argument. On Windows a prompt containing a newline breaks the CLI's own command-line parsing: everything after the first line is re-parsed as further arguments, the flags that follow are silently dropped, and the run dies claiming `--skip-git-repo-check was not specified`. Any agent with a private system prompt or an attached skill produces a multi-line prompt, so that was every such Codex agent.

## Stopping and resuming

A running run can be stopped from the Run tab. The server kills the CLI's whole process tree via `tree-kill`, which matters more than it sounds: `claude` and `codex` both launch through an npm shim and spawn further processes for the tools they run (plus our own `mcp-bridge` for a workflow node), so killing the pid we hold would orphan that subtree and leave it editing files for a run the user already stopped. Killing what's running isn't sufficient on its own either, so the graph and subtask loops check a cancel flag before scheduling anything new. Stopped runs and steps get their own `cancelled` status, deliberately not styled as an error.

Every node transition is checkpointed onto the run — status, output, and any router choice — which rides along to `runs.json` with the existing throttled writes. Any workflow run that was stopped, failed, or was mid-flight when the server died therefore exposes a Resume that replays only what never finished. Nodes recorded as `done` keep their output and are not re-run; anything else, including a node that was in flight, goes back to pending. Skips aren't restored directly, since the skip fixed-point re-derives them from the edges and the restored router choices anyway, and a second source of truth for the same fact is a bug waiting to happen.

The interrupted attempt's tasks stay in the history and the new attempt appends its own, so the log shows both tries. That means one node id can own several tasks, and the canvas takes the most recent rather than the first.

A run replays against the graph snapshot taken when it started (`workflowNodes`/`workflowEdges`/`workflowIsolation` on the run), not the live workflow — editing a workflow shouldn't silently rewrite a run already in flight, and the checkpoint is keyed by those node ids.

## Workspace isolation

Parallel branches sharing one directory means parallel agents overwriting each other's files. Turn on workspace isolation in the workflow editor and any batch of two or more nodes running at once gets one `git worktree` per node instead: separate directory, throwaway branch off `HEAD`, sharing the repo's object store so it costs almost nothing to set up.

When the batch finishes, each branch is integrated one at a time, because `git merge` takes the index lock and each merge needs to see the previous one to detect a genuine conflict between two siblings. Per branch: commit what the agent changed, run the workflow's test command inside that worktree, and merge back into the base branch only if it passes, then remove the worktree. A branch that fails its tests or conflicts on merge doesn't land, its node is marked failed so everything downstream is skipped, and its worktree is left on disk with the path in the node's log. Merges are never resolved automatically; a conflict aborts and leaves the base branch exactly as it was.

A step running on its own skips all of this and uses the working directory directly, since there's nobody to collide with and it would otherwise turn a linear workflow into one merge commit per step.

Two caveats. A worktree only holds git-tracked files, so `.gitignore`d directories (`node_modules`, `.env`, build caches) aren't there and the test command has to install what it needs. And a dirty base repo tends to block the merge, so commit or stash first. If the working directory isn't in a git repo, isolation is skipped with a note in the log and the run proceeds as before.

## Run history

Runs live in `server/runs.json` along with per-task logs and results, and they survive a restart. Writes are throttled to roughly one every 400ms so a chatty log stream doesn't hammer the disk.

If the server dies mid-run, the child process dies with it, so on the next startup anything still marked running gets flipped to error with a note explaining what happened. Whatever it had already logged is kept, and for a workflow run its checkpoint is too, so it can be resumed rather than restarted.

You can delete runs one at a time (hover for the trash icon) or clear the lot. Both ask first. Deleting a run that's still going is refused, and clear-all just skips those rather than failing outright.

Navigating to another tab doesn't stop anything. Execution is server side and doesn't care whether a browser is watching. Come back to the Run tab and click the run to pick the log back up.

## Auto-decompose

On a single agent run you can turn this on to have a read-only Claude planner split your prompt into a JSON array of subtasks first. Those then run one after another with the agent you picked. Sequential on purpose, since parallel agents writing into the same repo tend to trip over each other.

## Limitations

Local, single user, no auth.

Stopping is abrupt. There's no graceful "please wrap up" phase, and on Windows there can't be one — `tree-kill` shells out to `taskkill /T /F` there and ignores the signal you hand it, so the POSIX SIGTERM-then-SIGKILL courtesy has no equivalent. A file an agent was halfway through writing stays halfway written.

Resume re-runs the whole interrupted node rather than picking up inside it. The checkpoint is per node and can't record how far an agent got within one. Single-agent runs can be stopped but not resumed, for the same reason: there's no graph to checkpoint against.

Claude Code plugins can't be attached to Codex agents. Codex has its own plugin system, but it installs from configured marketplaces in a different format, so a directory cloned on the Plugins tab is not something a Codex node can load.

Codex has no per-tool allow/deny for its own tools either. Its `[tools]` config table holds a handful of named switches (`web_search` and friends) with no general enable/disable list, so a Codex node's shell and filesystem access is governed by the sandbox mode alone. The MCP-side `enabled_tools`/`disabled_tools` keys do exist, but they only cover tools served over MCP — here that means `ask_agent` and nothing else.

Workspace isolation covers a workflow's parallel branches and nothing else. Sub-agents an agent spawns itself with the `Task` tool share their parent's directory, since they live inside one CLI process this app doesn't orchestrate, and auto-decompose still runs its subtasks sequentially for the same reason.

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
