# Task: coordinators create their own members, with provider fallback

You are working in the AgentOrchestrator repo. Read `docs/orchestrator-notes.md`, `server/src/features/runs/team-calls.js`, `executor.js`, `cli-runners.js`, `delegation-policy.js`, `spawn-policy.js`, `server/src/features/agents/access.js`, `server/src/features/workflows/workflow-model.js`, `server/src/features/bridge/mcp-bridge.js` and the Team editor in `client/src/pages/WorkflowDetailPage.jsx` before changing anything.

## Why

The original goal of the app: a coordinator decides what the job needs and creates the member agents itself. Today a user has to create every agent by hand in the Agents tab and attach it to a Team. That fails in two ways:

1. A member that can never run kills the run. Real case: an agy member in `accept-edits` called `read_file` on a PNG, headless agy auto-denied it, the process exited with "no output produced: a tool required the read_file permission that headless mode cannot prompt for", and the work item failed. `classifyAgentFailure` returns `agent_error` for this, which is not a failover reason, so nothing tried another agent.
2. `spawn_agent` exists but cannot replace members: the spawned agent has no instructions or skills, there is no provider fallback, and its access is capped at the coordinator's own level, so a read-only coordinator can only ever spawn read-only agents.

Wanted end state: a Team can run with zero hand-made members. The coordinator spawns members from role blueprints defined on the Team; each blueprint has an ordered provider list (for example agy first, then Claude); if a provider cannot run the job, the server moves to the next one by itself.

## How to work

- One phase at a time. After each phase: `node --test` in `server/` must pass, then stop and give me a short summary (what changed, files, tests, open questions). Wait for "continue".
- Do not commit.
- Existing `agents.config.json` and `workflows.config.json` must load and run unchanged; migrate on load as the code already does.
- Tests never call real CLIs; use the injectable runner the team-call tests already use.
- All UI text in `client/src/i18n.js`, Vietnamese and English. No new input fields on the Run screen: everything a run needs comes from the chat message. No em dashes anywhere.
- Update `README.md` and `docs/orchestrator-notes.md`.

## Phase 1: failures that should move to the next provider

- Add failure reasons that mean "this provider cannot do this job here", not "the task is wrong":
  - `tool_denied`: headless permission auto-denial (agy's "auto-denied", "cannot prompt for", "requires the ... permission"; Claude's and Codex's equivalents if they show up in stderr or the event stream).
  - `no_output`: the process exited without a result message.
  - `capability_unavailable`: the provider reports it has no tool for what was asked (for example no image generation).
- Detect them in `classifyAgentFailure` and in the agy/claude/codex stream parsers. Keep `quota` and `provider_unavailable` as they are.
- Add the new reasons to the set that allows failover, both for team members with an `agentIds` list and for spawned agents (Phase 2). Do not put them on the cooldown map for the rest of the run (unlike `quota`): the same provider may work for a different job.
- Log the reason in plain words on the task.

Done when: tests show a member with `[agyAgent, claudeAgent]` falling over to Claude on each new reason, and an ordinary `agent_error` still not failing over.

## Phase 2: blueprints and provider fallback for spawn_agent

- On a Team, add `blueprints`: a list of roles the coordinator may spawn. Each blueprint:
  - `name` (alias-style, unique), `role` (one line, shown to the coordinator)
  - `instructions` (the system prompt the spawned agent gets) and `skillIds`
  - `accessLevel` (read / write / full)
  - `providers`: ordered list, each item `{ provider, model?, instructions? }`. The optional per-provider `instructions` are appended for that provider only, so a role can say different things to agy (generate a bitmap) and to Claude (draw an SVG instead).
  - optional Claude `tools` allowlist
- `spawn_agent` takes `blueprint` (name) plus `prompt`, `title` and `workItemId`. Ad-hoc spawning without a blueprint keeps working the way it does now.
- When a spawn names a blueprint, the server walks its provider list: skip providers that are not installed or are on a quota cooldown, run the next one, and on any failover reason from Phase 1 try the next provider in the same call. Return and log which provider did the work and why earlier ones were skipped.
- A spawned agent with a `workItemId` behaves like a member for that work item: the next `spawn_agent` call with the same `workItemId` and blueprint resumes the same session (reuse the Phase 1 session logic from the earlier Team work), stays on the provider that succeeded, and is replayed on resume like any finished delegation.
- `maxAgents` counts distinct spawned work items, not retries or fix rounds.

Done when: tests cover the provider walk, per-provider instructions, session reuse per work item, and replay on resume.

## Phase 3: access ceiling for team spawns

- Today a spawned agent is capped at its supervisor's own access. Keep that for agents that spawn on their own (outside a Team).
- Inside a Team, the ceiling is the Team's: add `spawnPolicy.maxAccessLevel` (default `read`), and cap each blueprint's `accessLevel` and tools by it. A read-only coordinator can then spawn writers only when the Team owner allowed it explicitly.
- Validation on save: a blueprint above `maxAccessLevel` is an error; a blueprint whose provider list is empty is an error; unknown providers or skills are errors.
- The `Task` tool (Claude's own sub-agent tool) stays forbidden for spawned agents.

Done when: tests show a read-only coordinator spawning a `write` blueprint under `maxAccessLevel: write`, and the same request rejected under the default.

## Phase 4: Teams without fixed members

- Validation: a Team needs at least one member OR spawning enabled with at least one blueprint.
- The coordinator's tool description lists the blueprints (name, role, access, provider order) next to any fixed members, and explains when to use which: members for fixed seats, blueprints for anything the job needs.
- Fixed members keep working exactly as now, including their `agentIds` fallback.

Done when: a test runs a Team with no members where the coordinator spawns two blueprints and gets both answers.

## Phase 5: UI

- Team editor: a "Blueprints" section (add, remove, edit; provider order as a reorderable list with installed/not-installed badges; access level capped by the Team's max), and `maxAccessLevel` in the spawn settings. Members become optional.
- Run tab: spawned members appear like members, with the provider that actually ran and the fallback log ("agy: tool_denied, switched to Claude").

## Final summary

List every new setting with its default, any migration, and anything you decided differently from this document and why.
