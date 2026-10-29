# Task: make Team workflows reliable for real use

You are working in the AgentOrchestrator repo (Node server in `server/`, React client in `client/`). A Team workflow is one coordinator agent plus named members; the coordinator hands work to members through the `ask_agent` MCP tool (`server/mcp-bridge.js`), and the server runs each call in `askAgent` (`server/executor.js`), which spawns a CLI through `runAgentProcess` (`server/cli-runners.js`). A team is stored as `team` and turned into a graph by `teamToGraph` (`server/workflow-model.js`).

Six problems make Team runs unreliable or expensive. Fix them in the phases below, in order.

## How to work

- Before changing anything, read: `server/executor.js` (askAgent, spawnAgent, executeGraph, resumeRun, checkpoint code), `server/cli-runners.js` (runAgentProcess, runClaudeProcess, runCodexProcess, runAgyProcess, bridge context), `server/delegation-policy.js`, `server/spawn-policy.js`, `server/workflow-model.js`, `server/workspace.js`, `server/run-store.js`, and the Team editor in `client/src/pages/WorkflowDetailPage.jsx`.
- Do one phase at a time. At the end of each phase: run `node --test` in `server/`, make sure everything passes, then stop and give me a short summary (what changed, which files, how you tested, anything you were unsure about). Wait for me to say "continue" before the next phase.
- Do not commit. I will review and commit myself.
- Keep saved configs working: `agents.config.json` and `workflows.config.json` written by the current version must load and run unchanged. Migrate on load the way the code already does for older shapes.
- Do not change Pipeline behaviour unless a phase says so.
- No new dependencies unless there is no reasonable way without one; if you add one, say why.
- Every user-facing string goes into `client/src/i18n.js` in both Vietnamese and English.
- Tests must not call real CLIs. If testing needs it, make the process runner injectable (or add a test-only fake runner) instead of spawning `claude`, `codex` or `agy`.
- Update `README.md` and `docs/orchestrator-notes.md` where behaviour changes.
- Never use an em dash in code comments, docs or UI text.

## Phase 1: members keep their context across fix rounds

Problem: every `ask_agent` call starts a fresh CLI process. When the coordinator sends a fix request for the same `workItemId`, the member does not remember its previous attempt; it only sees the coordinator's new message.

Wanted:
- Record the CLI session id returned by `runAgentProcess` on the delegation for that `workItemId` (Claude and agy already support resuming: `--resume` / `--conversation`, see how chat follow-ups use it).
- On the next `ask_agent` call for the same `workItemId` and the same target agent, resume that session instead of starting fresh.
- If the provider cannot resume, or resuming fails, fall back to a fresh process with a short transcript of the previous attempt (its question and answer) prepended, the same way chat follow-ups already fall back.
- A different `workItemId`, or a failover to another agent, always starts fresh.
- Log in the task which happened: resumed session, transcript fallback, or fresh.

Done when: a test shows the second call for the same work item passes the stored session id to the runner, a failover call does not, and the transcript fallback is used when resume is unavailable.

## Phase 2: server-side failover through an ordered agent list per member

Problem: failover between providers is decided by the coordinator model, based on prompt instructions. It can forget, pick the wrong member, or retry an unavailable provider.

Wanted:
- A team member can have an ordered list of agents instead of one: `agentIds: [primary, backup, ...]`. Keep reading the old single `agentId` (migrate it to a one-item list).
- When `ask_agent` targets that member, the server picks the agent:
  1. skip agents whose provider is not available (`PROVIDER_AVAILABILITY`);
  2. skip agents whose provider hit `quota` earlier in this run (keep a per-run cooldown map; if the error text contains a reset time you can parse, honour it, otherwise keep it for the rest of the run);
  3. run the first remaining one; if it fails with a reason in `FAILOVER_REASONS`, mark it and try the next one inside the same `ask_agent` call, same `workItemId`;
  4. once a work item has run on an agent successfully, later calls for that work item stay on that agent unless it becomes unavailable.
- The coordinator sees one member. Return which agent actually did the work in the tool result and in the task log.
- `delegation-policy.js` rules stay enforced for the coordinator; failover inside a member is the server's own decision and must not be rejected by them.
- Validation: every agent in the list must exist; no duplicates; at least one.
- UI: in the Team editor, a member's agent picker becomes an ordered list (add, remove, move up/down), with the provider shown and a warning on providers that are not installed.
- The `ask_agent` tool description the server builds must no longer tell the coordinator to pick backups itself. Do not edit saved workflow processes; I will remove the backup routing lines from mine.

Done when: tests cover skip-unavailable, failover on `quota`, cooldown for later calls in the same run, and stickiness per work item.

## Phase 3: resuming a Team run does not redo finished work

Problem: checkpoints are per graph node. A team has one auto node (the coordinator), so resuming a crashed or stopped team run restarts the coordinator and makes it hand out every work item again, including ones members already finished.

Wanted:
- Persist each finished delegation on the run: `workItemId`, target, a fingerprint of the question (reuse `questionFingerprint`), answer, status, agent used, session id.
- When the coordinator is resumed: first try to resume the coordinator's own CLI session (same mechanism as Phase 1). If that is not possible, start it fresh with a short summary of the finished work items and their answers prepended.
- If a resumed coordinator sends an `ask_agent` call whose `workItemId` and question fingerprint match a finished delegation, return the stored answer immediately and log it as replayed, without spawning anything.
- Unfinished or failed delegations run normally.

Done when: a test resumes a team run after two finished delegations and shows that only the third one spawns a process.

## Phase 4: isolate members that write in parallel

Problem: workspace isolation only covers parallel branches of a graph batch. Team members always share the run's working directory, so two engineers working at the same time can overwrite each other; only a prompt rule prevents it.

Wanted:
- When the workflow has isolation enabled and the run's folder is a git repo, each work item that a member with write or full access works on gets its own worktree (reuse `server/workspace.js`: createWorktree / integrateWorktree), created on the first call for that work item and reused for its fix rounds.
- Read-only members (reviewer) run in the worktree of the work item they are reviewing. The coordinator says which one through a new optional `reviewOf` argument on `ask_agent` (the `workItemId` under review); without it they run in the base folder.
- A work item's worktree is integrated (tests from `isolation.testCommand`, then merge) when the coordinator calls a new bridge tool `complete_work_item({ workItemId })`, or at the end of the run for items whose last review passed. Conflicts and failing tests behave exactly like Pipeline isolation today.
- Without isolation enabled, behaviour stays as it is now.

Done when: a test with a temporary git repo runs two work items in parallel worktrees, integrates both, and a conflicting pair is reported without touching the base branch.

## Phase 5: limits for the whole run

Problem: only `spawn_agent` has a token budget. Member calls have no count limit, no time limit (the bridge timeout is 6 hours) and no budget.

Wanted, configured on the Team workflow with safe defaults:
- `maxDelegations` per run (default 30);
- `callTimeoutMinutes` per `ask_agent` call (default 30): on timeout, kill the process tree and return a clear `failureReason: "timeout"`;
- `runTokenBudget` for the whole run, members and spawned agents included (default 2,000,000; 0 = no limit): checked before each new call, with the same caveat as spawn about calls already running.
- When a limit is hit, the tool returns an error the coordinator can act on ("write your final report with what is done"), not a crash.
- Show usage against limits in the Run tab for team runs.

Done when: tests cover each limit returning a clean tool error.

## Phase 6: keep the coordinator's context small

Problem: a member's full answer goes straight into the coordinator's context. Long code reports or scripts make the coordinator (often Opus) slow, expensive and forgetful after a few rounds.

Wanted:
- Store every member answer in full on the task (as now) and, when it is longer than a threshold (default 4,000 characters), return to the coordinator a trimmed version: the first part of the answer, plus a note with the task id and that the full text can be fetched.
- Add a bridge tool `read_result({ taskId, offset?, limit? })` so the coordinator can read the full answer in pages when it really needs it.
- The threshold is a Team setting.

Done when: a test shows a long answer is trimmed in the tool result and `read_result` returns the full text in pages.

## Final summary

After Phase 6, give me: a list of all new or changed settings with their defaults, any migration that runs on load, and anything you decided differently from this document and why.
