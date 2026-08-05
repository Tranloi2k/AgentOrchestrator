---
title: Running Claude Code and Codex as a multi-agent system, without API keys
published: false
description: A local web UI that drives claude -p and codex exec as coordinated agents, plus the CLI behaviour that cost me an afternoon.
tags: showdev, ai, node, react
---

<!-- COVER IMAGE (essential): add `cover_image: <url>` to the frontmatter above once uploaded.
     Content: the workflow canvas mid-run, nodes colored by status, dashed purple call arrows visible.
     Crop to roughly 1000x420. -->

I wanted to play with multi-agent setups, but every framework I looked at opens with "get an API key". I already pay for Claude Code, and my ChatGPT plan includes the Codex CLI. Both are on my laptop, both already logged in. Paying per token a second time just to coordinate the same models felt like the wrong move.

So the whole project is built on one idea: don't call the API, drive the CLI. Every agent is a child process, either `claude -p` or `codex exec`, spawned with flags built from a config I edit in the browser. There's nowhere to paste an API key because nothing ever asks for one. The subprocess inherits whatever session the CLI already has.

<!-- IMAGE 1 (essential): the agent form with the "Runs on" dropdown open, showing Claude Code and Codex.
     This is the proof of the paragraph above: two CLIs, no API key field anywhere on the form.
     Alt: "Agent configuration form with a provider dropdown listing Claude Code and Codex" -->

## What's in it

You configure agents in a web UI: pick which CLI runs it, the model, permission mode, which tools it can touch, a private system prompt, and any shared skills. Skills are just reusable instruction blocks you write once and attach to several agents.

Workflows are where it gets useful. It's a node graph rather than a linear chain, so you can fan out into parallel branches, merge several branches back into one node, route conditionally, or let agents call each other directly.

Runs stream to the browser over a WebSocket and get written to disk, so you keep the full per-task log after a restart.

<!-- IMAGE 2 (essential): the workflow editor. Show the canvas with 3+ nodes, the node ids visible under
     each title, the dashed purple two-way call arrows, and the legend in the corner. Node panel open on
     the right is a bonus. This is the single most distinctive screen in the app.
     Alt: "Workflow editor showing a node graph with data edges and dashed two-way call arrows" -->

## How it's wired

```
React (Vite)  ──HTTP──►  Express  ──spawn──►  claude -p --output-format stream-json
     ▲                      │                 codex exec --json
     └────WebSocket─────────┘                        │
          (log stream)      ▲──────────stdout JSONL──┘
```

Both CLIs emit JSONL on stdout, so the orchestrator parses lines, pushes them to subscribers, and resolves a final result string per task. Everything funnels through one dispatcher:

```js
function runAgentProcess(opts) {
  const provider = opts.agent?.provider === "codex" ? "codex" : "claude";
  return provider === "codex" ? runCodexProcess(opts) : runClaudeProcess(opts);
}
```

Both branches return the same `{ ok, resultText }`, so nothing downstream has to care which vendor answered. That mattered more than I expected once workflows and agent-to-agent calls landed, since all of them reuse the same function.

## Three ways agents talk to each other

Plain edges are the boring case. Node B starts when node A finishes and gets A's output injected as `{{previous}}`. Several outgoing edges run in parallel, several incoming edges make a merge node that waits for all of them.

Router nodes are one step up. The node's own answer picks exactly one outgoing branch, matched against a condition label on each edge. Branches that don't get picked are marked skipped and never spend a token.

The one I actually built this for is two-way calls. A node can call another node's agent while it's still running, block until the full answer comes back, then keep going. That's done with a small stdio MCP server exposing a single `ask_agent` tool, injected inline:

```js
return JSON.stringify({
  mcpServers: {
    "agent-bridge": { command: "node", args: [BRIDGE_SCRIPT], env },
  },
});
```

The tool call hits an internal HTTP endpoint, which spawns the target node's agent synchronously and hands its output back as the tool result. Call depth is capped at 3 so a bad graph can't recurse forever.

What this buys you is a Project Manager agent that hands work to a Frontend Engineer, waits for actual code to be written, sends a summary to a Code Reviewer, waits for the review, and then decides whether to loop back for fixes. The order isn't baked into the graph. The PM works it out at runtime from its prompt, and each call shows up as its own task in the run so you can read the whole exchange.

<!-- IMAGE 3 (essential): a finished run of that PM workflow. Task list showing the "PM asks Frontend
     Engineer" and "PM asks Code Reviewer" call tasks, at least one expanded so the question and answer
     are readable. This is what proves the feature is real and not a mockup.
     Alt: "Run view listing agent-to-agent call tasks with their logs expanded" -->

## Stuff that broke

My first Codex run through the UI just sat there. No output, no error, status stuck on running. The only clue was a warning in the log: `Reading additional input from stdin...`.

`codex exec` checks whether stdin is a TTY, and when it isn't, it waits to read stdin and append it to your prompt as a `<stdin>` block. Node's `spawn` hands the child a pipe by default. Nothing writes to it, nothing closes it, so codex waits forever. One option fixes it:

```js
spawn("codex", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
```

Next one was my own fault. `codex --help` documents `-a/--ask-for-approval` with three modes, so I wired it into the agent form and shipped it. First run:

```
error: unexpected argument '-a' found
```

<!-- IMAGE 4 (optional, cheap): terminal screenshot of that exact error. Just run
     `codex exec "hi" -a never` and capture the output. Costs 10 seconds and makes the story concrete.
     Alt: "Terminal showing codex exec rejecting the -a flag" -->

That flag lives on the top-level `codex` command, not on `codex exec`. Makes sense once you think about it, since a non-interactive run has nobody to approve anything. I deleted the control instead of leaving a setting in the UI that quietly does nothing.

I also started with a free text box for the Codex model name, which is both bad UX and a great way to collect typos. Then I found `~/.codex/models_cache.json`, which the CLI writes at login and fills with the models your account can actually use. Reading that file gives a real dropdown that can't drift out of sync with your entitlements, and I don't have to chase model releases.

<!-- IMAGE 5 (optional): the Codex model dropdown open, populated with the real model list.
     Alt: "Model dropdown populated from the Codex CLI's local model cache" -->

The worst one was the graph layout. Two-way calls are usually mutual, since the PM can call the reviewer and the reviewer reports back to the PM. I fed those relationships into the same layering pass I use for data edges, which sets each node's layer to the longest path from a root. With a cycle in the input the fixed point never settles. I opened the editor and the canvas was 11320px wide with every node shoved off screen.

Layout now runs on data edges only, and call relationships are drawn as a separate visual overlay. I also capped the layer number itself at `nodes.length - 1`, because an iteration cap on its own still lets a few passes inflate it before it bails.

## Sub-agents needed a nudge

Claude Code has a built-in tool that lets an agent spawn its own sub-agents. Adding it to the tool list as a checkbox worked in the narrow sense: the flag went through, the tool was available. The model just wouldn't reach for it. Unless the prompt explicitly said to use it, the agent would grind through everything itself, which makes the checkbox pointless.

The fix was to make ticking the box the entire setup. When that tool is explicitly allowed, the server appends a block to the system prompt covering when splitting work is worth it, when it isn't, and the fact that a sub-agent can't see the parent's conversation so every delegation has to carry its own context. Then `--forward-subagent-text` so their output shows up in the parent's log instead of collapsing into a summary.

I renamed it in the UI too. The tool is called `Task` in the CLI, which means nothing in an app where every workflow step is already a task, so the checkbox just says "Spawn sub-agents".

To check it actually worked I wrote a prompt asking for three unrelated things about a codebase, with no mention of sub-agents anywhere in it. It spawned three, one per question, and merged the answers.

<!-- IMAGE 6 (recommended): the run log from that test, scrolled to where the three sub-agent spawns are
     visible one after another, ideally with a forwarded sub-agent reply below them. Alternative if that's
     hard to crop: the tool chip row with "Spawn sub-agents" selected and the helper line underneath.
     Alt: "Run log showing three sub-agents spawned from a single prompt" -->

## Rough edges

It's local and single user. No auth, no multi-tenancy, and I have no plans there.

There's no stop button for a run in progress, which is the gap that annoys me most.

Codex agents can't use `ask_agent`, since the MCP bridge is Claude only. They work fine as ordinary workflow nodes. Codex also has no per-tool allow list, so permissions come down to sandbox mode plus a network flag, because that's all `codex exec` gives you.

Agents writing to the same repo in parallel can stomp on each other. A `git worktree` per agent is the obvious answer and I haven't built it yet.

If the server dies mid-run the child process goes with it and can't be resumed. On restart, anything still marked running gets flipped to error with a note explaining why, and whatever logs it managed to write are kept. Leaving it stuck at "running" forever seemed worse than being blunt about it.

## Stack

Node, Express and `ws` on the server, React and Vite on the client, `cross-spawn` for the child processes, `@modelcontextprotocol/sdk` for the agent bridge. Config sits in plain JSON files. No database, no queue.

Repo: https://github.com/Tranloi2k/AgentOrchestrator (MIT)

If you've built something similar on top of CLI tools instead of APIs, I'd be curious how you handled process lifecycle. That's the part I'm least happy with.
