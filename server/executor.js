/**
 * Run execution: ad-hoc single-agent runs (optionally auto-decomposed), workflow graph runs
 * (parallel branches, router nodes, per-branch git worktrees merged back one at a time),
 * checkpoint/resume, stopping, and the synchronous agent-to-agent `askAgent` call.
 */
import { nanoid } from "nanoid";
import {
  openWorkspaceSession,
  createWorktree,
  integrateWorktree,
  closeWorkspaceSession,
  finalizeWorkspaceReview,
} from "./workspace.js";
import { finishDelegation, reserveDelegation } from "./delegation-policy.js";
import { DEFAULT_CWD, MAX_CALL_DEPTH } from "./config.js";
import { buildSpawnedAgent, checkSpawnLimits, spawnedCount, spawnedTokens } from "./spawn-policy.js";
import { pickRoute, routeInstruction } from "./workflow-model.js";
import { getAgent, getWorkflow, nodeTitle } from "./registry.js";
import {
  runs,
  cancelling,
  isCancelling,
  scheduleSaveRuns,
  emit,
  pushTaskLog,
  newTask,
  summarize,
  canResume,
} from "./run-store.js";
import { runAgentProcess, killRunProcesses, getBridgeSession } from "./cli-runners.js";

/**
 * Marks a run as stopping and kills every process it currently owns. Returns once the signals
 * are sent — the run's own loop notices `cancelling`, finishes unwinding (including cleaning up
 * any git worktrees), and is what actually flips the run to `cancelled`.
 */
function stopRun(runId) {
  const run = runs.get(runId);
  if (!run) return false;
  if (run.status !== "running") {
    throw new Error("Run này không còn chạy — không có gì để dừng.");
  }
  cancelling.add(runId);
  emit({ runId, type: "run-status", status: "running", stopping: true });

  for (const task of run.tasks) {
    if (task.status === "running") pushTaskLog(runId, task.id, "🛑 Người dùng yêu cầu dừng — đang kết thúc tiến trình...");
  }
  killRunProcesses(runId);
  // No live child (e.g. stopped in the gap between two nodes) — the loop still picks up the
  // flag on its next iteration and stops there.
  return true;
}

async function decomposePrompt({ runId, taskId, prompt, cwd }) {
  const planPrompt = [
    "Hãy chia nhỏ yêu cầu sau thành các subtask độc lập, mỗi subtask nên đủ nhỏ để một agent lập trình riêng có thể thực hiện.",
    "CHỈ trả lời bằng một JSON array of strings, không thêm giải thích, không markdown code fence.",
    "Nếu yêu cầu đã đủ nhỏ, trả về mảng chỉ có 1 phần tử.",
    "",
    `Yêu cầu: ${prompt}`,
  ].join("\n");

  const { resultText } = await runAgentProcess({
    runId,
    taskId,
    prompt: planPrompt,
    cwd,
    agent: { permissionMode: "plan", allowedTools: [] },
  });

  try {
    const match = resultText.match(/\[[\s\S]*\]/);
    const arr = JSON.parse(match ? match[0] : resultText);
    if (Array.isArray(arr) && arr.length && arr.every((x) => typeof x === "string")) {
      return arr;
    }
  } catch {
    /* fall through */
  }
  return [prompt];
}

/**
 * Two-way agent interaction: called (via the HTTP endpoint the mcp-bridge process hits)
 * while `callerNodeId` (a node inside the running `workflowId`) is mid-run inside `runId`.
 * Permission is scoped to that one workflow's graph: `callerNodeId` must list
 * `targetNodeId` in its own `calleeNodeIds` (set in the workflow editor, not on the agent).
 * Spawns the target node's agent synchronously, appends the exchange as its own task in
 * the same run (visible in the UI right alongside whatever triggered it), and returns the
 * callee's full answer text back to the caller's `ask_agent` tool call so it can continue.
 */
async function askAgent({ runId, workflowId, callerNodeId, targetNodeId, question, workItemId, parentWorkItemId, cwd, depth }) {
  const run = runs.get(runId);
  if (!run) throw new Error("Run không tồn tại (có thể đã kết thúc).");
  if (depth >= MAX_CALL_DEPTH) throw new Error("Đã đạt giới hạn độ sâu gọi agent (chống vòng lặp gọi nhau).");

  // The graph the run started with, not the live workflow: editing a workflow mid-run must not
  // change who may hand work to whom inside that run.
  if (!run.workflowId || run.workflowId !== workflowId) throw new Error("Run này không thuộc workflow đó.");
  const workflow = snapshotWorkflow(run);
  const callerNode = workflow.nodes.find((n) => n.id === callerNodeId);
  if (!callerNode?.calleeNodeIds?.includes(targetNodeId)) {
    throw new Error("Bước này chưa được phép giao việc cho bước đó (mục \"Được giao việc cho\" trong Workflow editor).");
  }
  if (targetNodeId === callerNodeId) throw new Error("Một bước không được tự gọi chính nó.");

  const targetNode = workflow.nodes.find((n) => n.id === targetNodeId);
  if (!targetNode) throw new Error("Bước đích không còn tồn tại trong workflow.");
  const targetAgent = agentForNode(targetNode);

  const task = newTask(`💬 ${nodeTitle(callerNode)} giao [${workItemId}] cho ${nodeTitle(targetNode)}`, "agent-call", targetNode.id, targetAgent);
  if (run.activeTurnId) task.turnId = run.activeTurnId; // part of a chat turn: deleted with it
  const delegation = reserveDelegation(run, {
    callerNodeId,
    targetNodeId,
    workItemId,
    parentWorkItemId,
    question,
    assignmentId: task.id,
  });
  task.workItemId = delegation.workItemId;
  task.parentWorkItemId = delegation.parentWorkItemId;
  run.tasks.push(task);
  emit({ runId, taskId: task.id, type: "task-created", task });
  task.status = "running";
  emit({ runId, taskId: task.id, type: "task-status", status: "running" });
  pushTaskLog(runId, task.id, `❓ ${question}`);

  let processResult;
  try {
    processResult = await runAgentProcess({
      runId,
      taskId: task.id,
      prompt: targetNode.role ? `Vai trò của bạn trong team (${targetNode.alias}): ${targetNode.role}

---

${question}` : question,
      cwd,
      agent: targetAgent,
      node: targetNode,
      workflow,
      depth: depth + 1,
    });
  } catch (err) {
    pushTaskLog(runId, task.id, `❌ Lỗi nội bộ khi chạy agent: ${err.message}`);
    processResult = { ok: false, resultText: "", usage: null, failureReason: "agent_error" };
  }
  const { ok, resultText, usage, failureReason, sessionId } = processResult;

  task.resultText = resultText;
  task.usage = usage;
  task.sessionId = sessionId || null;
  task.failureReason = failureReason || null;
  task.status = isCancelling(runId) ? "cancelled" : ok ? "done" : "error";
  finishDelegation(delegation, {
    ok: task.status === "done",
    failureReason: task.status === "cancelled" ? "cancelled" : failureReason,
  });
  emit({ runId, taskId: task.id, type: "task-status", status: task.status });

  return { answer: resultText, ok: task.status === "done", failureReason: task.failureReason };
}

/** --------------------------- spawn_agent: supervisor creates agents on the fly --------------------------- */

/**
 * Handles a supervisor's `spawn_agent` call (via the bridge). The caller is identified only by
 * its bridge session (see cli-runners.js), so the policy, depth and cwd used here are the ones
 * the server handed out, not whatever the request claims. Runs the new agent synchronously as
 * its own task in the same run and returns its answer.
 *
 * Limits: MAX_CALL_DEPTH here, maxAgents and tokenBudget per run in checkSpawnLimits, and the
 * supervisor's own access level and tools as the child's ceiling in buildSpawnedAgent.
 */
async function spawnAgent({ sessionId, provider, model, tools, accessLevel, prompt, title }) {
  const session = getBridgeSession(sessionId);
  if (!session) throw new Error("Phiên agent-bridge không hợp lệ hoặc đã kết thúc.");
  const { runId, taskId: parentTaskId, agent: supervisor, depth, cwd } = session;
  const policy = supervisor?.spawnPolicy;
  if (!policy?.enabled) throw new Error("Chỉ điều phối viên của một Team có bật spawn_agent mới được tạo agent.");

  const run = runs.get(runId);
  if (!run || run.status !== "running") throw new Error("Run không còn chạy.");
  if (isCancelling(runId)) throw new Error("Run đang được dừng — không tạo agent mới.");
  if (depth >= MAX_CALL_DEPTH) throw new Error("Đã đạt giới hạn độ sâu gọi agent (chống vòng lặp).");
  if (!String(prompt || "").trim()) throw new Error("Thiếu prompt cho agent mới.");

  checkSpawnLimits(run, policy);

  const { spawn, ...agentConfig } = buildSpawnedAgent(policy, supervisor, { provider, model, tools, accessLevel });
  const parentTask = run.tasks.find((t) => t.id === parentTaskId);
  const label = String(title || prompt).trim().split("\n")[0].slice(0, 80);
  const agent = { id: null, name: `${spawn.provider}${spawn.model ? ` · ${spawn.model}` : ""}`, ...agentConfig };

  const task = newTask(`🧬 ${label}`, "agent-spawn", parentTask?.nodeId || null, agent);
  if (run.activeTurnId) task.turnId = run.activeTurnId; // part of a chat turn: deleted with it
  task.spawnedByTaskId = parentTaskId || null;
  task.spawn = {
    ...spawn,
    supervisorName: supervisor.name || null,
    limits: { maxAgents: policy.maxAgents, tokenBudget: policy.tokenBudget },
  };
  run.tasks.push(task);
  emit({ runId, taskId: task.id, type: "task-created", task });
  task.status = "running";
  emit({ runId, taskId: task.id, type: "task-status", status: "running" });
  pushTaskLog(runId, task.id, `🧬 ${supervisor.name || "Supervisor"} tạo agent ${agent.name}`);
  if (parentTaskId) pushTaskLog(runId, parentTaskId, `🧬 Tạo agent ${agent.name}: ${label}`);
  pushTaskLog(runId, task.id, `❓ ${prompt}`);

  let processResult;
  try {
    processResult = await runAgentProcess({ runId, taskId: task.id, prompt, cwd, agent, depth: depth + 1 });
  } catch (err) {
    pushTaskLog(runId, task.id, `❌ Lỗi nội bộ khi chạy agent: ${err.message}`);
    processResult = { ok: false, resultText: "", usage: null, failureReason: "agent_error" };
  }
  const { ok, resultText, usage, failureReason, sessionId: cliSessionId } = processResult;

  task.resultText = resultText;
  task.usage = usage;
  task.sessionId = cliSessionId || null;
  task.failureReason = failureReason || null;
  task.status = isCancelling(runId) ? "cancelled" : ok ? "done" : "error";
  emit({ runId, taskId: task.id, type: "task-status", status: task.status, usage });

  return {
    answer: resultText,
    ok: task.status === "done",
    failureReason: task.failureReason,
    usage: {
      spawned: spawnedCount(run),
      maxAgents: policy.maxAgents,
      tokensUsed: spawnedTokens(run),
      tokenBudget: policy.tokenBudget,
    },
  };
}

/** --------------------------- ad-hoc single-agent run (optionally auto-decomposed) --------------------------- */

async function startRun({ prompt, agentId, decompose, cwd, targetBranch = null }) {
  const agent = getAgent(agentId);
  const runId = nanoid(10);
  const run = {
    id: runId,
    prompt,
    agentId: agent.id,
    workflowId: null,
    decompose: !!decompose,
    cwd: cwd || DEFAULT_CWD,
    // The git branch the run's work lands on when Accepted (null = whatever is checked out).
    targetBranch,
    status: "running",
    createdAt: Date.now(),
    tasks: [],
  };
  runs.set(runId, run);
  emit({ runId, type: "run-created", run: summarize(run) });

  process.nextTick(() =>
    executeRun(run, agent).catch((err) => {
      run.status = "error";
      run.error = err.message;
      emit({ runId, type: "run-status", status: "error", error: err.message });
    })
  );

  return runId;
}

async function executeRun(run, agent) {
  const { id: runId, prompt, decompose } = run;
  const { workspace, fatal } = await openRunWorkspace(run, { isolation: {} });
  if (!workspace && fatal) {
    run.status = "error";
    run.error = run.review?.reason;
    cancelling.delete(runId);
    emit({ runId, type: "run-status", status: "error", error: run.error });
    return;
  }
  // No workspace = not a git repo, so there's nothing to review against: run where the user
  // pointed us, same as before review existed.
  const executionCwd = workspace ? workspace.session.reviewDir : run.cwd;

  // Same shape as executeWorkflowRun: whatever happens in the body, the review has to be sealed
  // and the session torn down. Skipping it would strand the agent's work in a worktree the user
  // has no way to reach — no diff shown, no Accept, no Decline.
  try {
    let subtasks = [prompt];

    if (decompose) {
      const plannerTask = newTask("Planner: chia nhỏ yêu cầu", "planner");
      run.tasks.push(plannerTask);
      emit({ runId, taskId: plannerTask.id, type: "task-created", task: plannerTask });
      plannerTask.status = "running";
      emit({ runId, taskId: plannerTask.id, type: "task-status", status: "running" });

      subtasks = await decomposePrompt({ runId, taskId: plannerTask.id, prompt, cwd: executionCwd });

      plannerTask.status = isCancelling(runId) ? "cancelled" : "done";
      emit({ runId, taskId: plannerTask.id, type: "task-status", status: plannerTask.status });
    }

    for (const subPrompt of subtasks) {
      // Stopping between subtasks: nothing is running to kill, so the loop itself has to notice.
      if (isCancelling(runId)) break;

      const task = newTask(subPrompt, "agent", null, agent);
      run.tasks.push(task);
      emit({ runId, taskId: task.id, type: "task-created", task });
      task.status = "running";
      emit({ runId, taskId: task.id, type: "task-status", status: "running" });

      const { ok, resultText, usage, sessionId } = await runAgentProcess({
        runId,
        taskId: task.id,
        prompt: subPrompt,
        cwd: executionCwd,
        agent,
      });

      task.resultText = resultText;
      task.usage = usage;
      task.sessionId = sessionId || null;
      task.status = isCancelling(runId) ? "cancelled" : ok ? "done" : "error";
      emit({ runId, taskId: task.id, type: "task-status", status: task.status });
    }

    run.status = isCancelling(runId) ? "cancelled" : "done";
  } finally {
    cancelling.delete(runId);
    if (workspace) await finalizeRunReview(run, workspace);
  }
  emit({ runId, type: "run-status", status: run.status });
}

/** --------------------------- workflow run (graph: parallel branches + conditional routing) --------------------------- */

async function startWorkflowRun({ prompt, workflowId, cwd, targetBranch = null }) {
  const workflow = getWorkflow(workflowId);
  if (!workflow || !workflow.nodes.length) {
    throw new Error("Workflow không tồn tại hoặc không có bước nào");
  }
  const runId = nanoid(10);
  const run = {
    id: runId,
    prompt,
    agentId: null,
    workflowId: workflow.id,
    // Snapshot of the graph AS IT WAS when the run started. The run (and any later resume)
    // replays against this, not against the live workflow — editing a workflow shouldn't
    // silently rewrite a run that's already in flight, and the checkpoint below is keyed by
    // these node ids.
    // Deep copies, so nothing that later happens to the stored workflow can reach into a run.
    workflowType: workflow.type || "pipeline",
    workflowNodes: structuredClone(workflow.nodes),
    workflowEdges: structuredClone(workflow.edges),
    workflowIsolation: structuredClone(workflow.isolation),
    decompose: false,
    cwd: cwd || DEFAULT_CWD,
    targetBranch,
    status: "running",
    createdAt: Date.now(),
    tasks: [],
    checkpoint: emptyCheckpoint(),
  };
  runs.set(runId, run);
  emit({ runId, type: "run-created", run: summarize(run) });

  launchWorkflowRun(run);
  return runId;
}

/** --------------------------- checkpoint & resume --------------------------- */

/** Per-node progress, rebuilt into the in-memory graph state on resume. Lives on the run so it
 * rides along to runs.json with every other emit — i.e. it survives a crash, not just a stop. */
function emptyCheckpoint() {
  return { nodeStates: {}, outputs: {}, routerChoice: {} };
}

/** Rebuilds the workflow object a run executes against, from the run's own snapshot. */
function snapshotWorkflow(run) {
  return {
    id: run.workflowId,
    nodes: run.workflowNodes || [],
    edges: run.workflowEdges || [],
    isolation: run.workflowIsolation || { enabled: false, testCommand: "", keepOnFailure: true },
  };
}

function launchWorkflowRun(run) {
  process.nextTick(() =>
    executeWorkflowRun(run, snapshotWorkflow(run)).catch((err) => {
      run.status = "error";
      run.error = err.message;
      emit({ runId: run.id, type: "run-status", status: "error", error: err.message });
    })
  );
}

/**
 * A node is worth re-running unless it already finished cleanly. `error` counts as re-runnable
 * on purpose: that's usually the node the run died on, and "resume" is meant to pick up exactly
 * there. `skipped` is dropped back to pending too — the skip is re-derived from the edges and
 * the restored router choices anyway, so restoring it would just be a second source of truth.
 */
function checkpointStateFor(saved) {
  return saved === "done" ? "done" : "pending";
}

/**
 * Re-runs a workflow run from its checkpoint: nodes that already finished keep their recorded
 * output and are not re-run, everything else starts over. Tasks from the interrupted attempt
 * stay in the history as-is and the new attempt appends its own, so the log shows both tries
 * rather than pretending the first one didn't happen.
 */
function resumeRun(runId) {
  const run = runs.get(runId);
  if (!run) return false;
  if (run.status === "running") throw new Error("Run này đang chạy — không cần resume.");
  if (!run.workflowId) {
    throw new Error("Chỉ run theo workflow mới resume được (run 1 agent không có checkpoint theo node).");
  }
  if (!canResume(run)) throw new Error("Run này đã chạy xong tất cả các bước — không còn gì để chạy tiếp.");

  cancelling.delete(runId);
  run.status = "running";
  run.error = null;
  run.resumedAt = Date.now();
  run.lastActivityAt = run.resumedAt;
  emit({ runId, type: "run-status", status: "running" });

  launchWorkflowRun(run);
  return true;
}


/** Combine one or more upstream node outputs into the prompt for the next node.
 * With a single input this behaves like the old linear {{previous}}; with several
 * (a fan-in / merge node) each is labelled by source so the agent can tell them apart. */
function buildNodePrompt(template, originalPrompt, inputs) {
  const joined = inputs.map((i) => i.text).join("\n\n---\n\n");
  if (template && template.trim()) {
    return template.replaceAll("{{prompt}}", originalPrompt).replaceAll("{{previous}}", joined);
  }
  if (!inputs.length) return originalPrompt;
  if (inputs.length === 1) {
    return [
      `Yêu cầu gốc: ${originalPrompt}`,
      "",
      "Kết quả từ bước trước trong workflow:",
      inputs[0].text,
      "",
      "Hãy tiếp tục thực hiện bước tiếp theo dựa trên thông tin trên.",
    ].join("\n");
  }
  return [
    `Yêu cầu gốc: ${originalPrompt}`,
    "",
    `Dưới đây là kết quả từ ${inputs.length} nhánh trước đó — hãy tổng hợp / xử lý tiếp:`,
    "",
    ...inputs.map((i) => `### Kết quả từ "${i.title}"\n${i.text}`),
  ].join("\n\n");
}

/** The coordinator of a team: its process description, then the user's request. A process
 * that places the request itself with {{prompt}} is used as written. */
function buildCoordinatorPrompt(process, originalPrompt) {
  if (process.includes("{{prompt}}")) return process.replaceAll("{{prompt}}", originalPrompt);
  return process.trim() ? `${process.trim()}

## Yêu cầu
${originalPrompt}` : originalPrompt;
}

/** The same lookup as getAgent, plus a team's own spawn_agent setting for its coordinator. */
function agentForNode(node) {
  const agent = getAgent(node.agentId);
  return node.spawnPolicy ? { ...agent, spawnPolicy: node.spawnPolicy } : agent;
}

/** Opens the git-worktree review session for a run (see server/workspace.js), plus the
 * "Workspace" task its setup/teardown logs go into.
 *
 * Returns `{ workspace, fatal }`. A null `workspace` splits two very different cases, and the
 * distinction comes from workspace.js rather than being guessed here:
 *   - `fatal: false` — the working directory just isn't a git repo. There is nothing to review
 *     against and nothing to protect, so the run goes ahead in `run.cwd` exactly as it did
 *     before review existed. Refusing here would mean the app couldn't touch a non-git folder
 *     at all.
 *   - `fatal: true`  — review should have applied and couldn't (dirty repo, git failure).
 *     Running anyway would edit files we can neither isolate nor roll back, so the caller stops.
 */
async function openRunWorkspace(run, workflow) {
  const task = newTask("🗂️ Workspace review (git worktree)", "workspace");
  if (run.activeTurnId) task.turnId = run.activeTurnId; // part of a chat turn: deleted with it
  run.tasks.push(task);
  emit({ runId: run.id, taskId: task.id, type: "task-created", task });
  task.status = "running";
  emit({ runId: run.id, taskId: task.id, type: "task-status", status: "running" });

  const log = (line) => pushTaskLog(run.id, task.id, line);
  const { session, fatal, reason } = await openWorkspaceSession({
    cwd: run.cwd,
    runId: run.id,
    isolation: workflow.isolation,
    targetBranch: run.targetBranch || null,
    log,
  });

  if (!session) {
    run.review = { status: "unavailable", reason };
    task.status = fatal ? "error" : "skipped";
    emit({ runId: run.id, taskId: task.id, type: "task-status", status: task.status });
    return { workspace: null, fatal };
  }
  log(
    `Review an toàn đang BẬT. Agent làm việc trên nhánh ${session.reviewBranch}; ` +
    `nhánh ${session.baseBranch} chỉ thay đổi sau khi bạn bấm Accept.`
  );
  return { workspace: { session, taskId: task.id, log }, fatal: false };
}

/**
 * Turns the review worktree into the run's reviewable diff and tears the session down.
 *
 * Runs from the callers' `finally`, so it must not throw: an exception raised here would replace
 * whatever actually killed the run with a git error, and skip the teardown besides. A failure to
 * produce the diff is therefore recorded as an `unavailable` review carrying its own reason.
 */
async function finalizeRunReview(run, workspace, keptDirs = []) {
  try {
    run.review = await finalizeWorkspaceReview(workspace.session, workspace.log);
    if (run.review.status === "pending") {
      workspace.log(
        keptDirs.length
          ? `🔎 Có ${run.review.files.length} file thay đổi đang chờ Accept hoặc Decline. Còn ${keptDirs.length} workspace lỗi được giữ lại để kiểm tra.`
          : `🔎 Có ${run.review.files.length} file thay đổi đang chờ Accept hoặc Decline.`
      );
    } else {
      workspace.log("ℹ️ Run không thay đổi file nào.");
    }
  } catch (err) {
    run.review = {
      status: "unavailable",
      reason: `Không dựng được bản review cho run này: ${err.message}. Nhánh ${workspace.session.reviewBranch} vẫn còn trong repo nếu bạn muốn tự xem.`,
    };
    workspace.log(`❌ ${run.review.reason}`);
  }

  try {
    await closeWorkspaceSession(workspace.session, keptDirs);
  } catch {
    /* teardown is best-effort; `git worktree prune` failing must not sink the run */
  }

  const wsTask = run.tasks.find((t) => t.id === workspace.taskId);
  if (wsTask?.status === "running") {
    wsTask.status = run.review.status === "unavailable" ? "error" : "done";
    emit({ runId: run.id, taskId: wsTask.id, type: "task-status", status: wsTask.status });
  }
  emit({ runId: run.id, type: "review-status", status: run.review.status });
}

/** Opens (and always closes) the review session around the actual graph walk. */
async function executeWorkflowRun(run, workflow) {
  const { workspace, fatal } = await openRunWorkspace(run, workflow);
  if (!workspace && fatal) {
    run.status = "error";
    run.error = run.review?.reason;
    cancelling.delete(run.id);
    emit({ runId: run.id, type: "run-status", status: "error", error: run.error });
    return;
  }
  // Worktrees deliberately left on disk (failed tests / merge conflicts) — closeWorkspaceSession
  // must not sweep the run's worktree root while any of these are still there.
  const keptDirs = [];
  try {
    await executeGraph(run, workflow, workspace, keptDirs);
  } finally {
    // The run is over one way or another; a later resume must not inherit the stop flag.
    cancelling.delete(run.id);
    if (workspace) await finalizeRunReview(run, workspace, keptDirs);
  }
}

async function executeGraph(run, workflow, workspace, keptDirs) {
  const { id: runId, prompt, cwd } = run;
  // Nodes with autoStart:false never run as part of the graph itself (not a root, and any
  // edge touching them is ignored here) — they only run when another node calls them via
  // ask_agent (askAgent() looks them up straight from workflow.nodes, independent of this).
  // That's how a caller node can fully own sequencing: call A, wait for it, then call B,
  // instead of the graph auto-fanning-out to both in parallel.
  const nodes = workflow.nodes.filter((n) => n.autoStart !== false);
  const nodeIdSet = new Set(nodes.map((n) => n.id));
  const edges = workflow.edges.filter((e) => nodeIdSet.has(e.from) && nodeIdSet.has(e.to));

  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const incomingOf = new Map(nodes.map((n) => [n.id, edges.filter((e) => e.to === n.id)]));
  const outgoingOf = new Map(nodes.map((n) => [n.id, edges.filter((e) => e.from === n.id)]));

  // Seeded from the run's checkpoint, so a resumed run starts with everything that already
  // finished still marked done (with its output) instead of re-running the whole graph. On a
  // fresh run the checkpoint is empty and this collapses to the old all-pending start.
  const cp = (run.checkpoint ||= emptyCheckpoint());
  const state = new Map(nodes.map((n) => [n.id, checkpointStateFor(cp.nodeStates[n.id])])); // pending|running|done|error|skipped|cancelled
  const output = new Map(Object.entries(cp.outputs));
  const routerChoice = new Map(Object.entries(cp.routerChoice)); // routerNodeId -> chosen edge id
  const taskIdByNode = new Map();

  const resumedNodes = nodes.filter((n) => state.get(n.id) === "done");

  /** Mirrors a node's resolved state into the run's checkpoint. Called on every transition, so
   * whatever runs.json holds at any moment is enough to resume from. */
  const checkpointNode = (nodeId) => {
    cp.nodeStates[nodeId] = state.get(nodeId);
    if (output.has(nodeId)) cp.outputs[nodeId] = output.get(nodeId);
    if (routerChoice.has(nodeId)) cp.routerChoice[nodeId] = routerChoice.get(nodeId);
    scheduleSaveRuns();
  };

  const edgeSourceResolved = (e) => ["done", "error", "skipped", "cancelled"].includes(state.get(e.from));
  const edgeActive = (e) => {
    const src = nodeById.get(e.from);
    if (state.get(e.from) !== "done") return false;
    if (src.kind === "router") return routerChoice.get(e.from) === e.id;
    return true;
  };

  if (resumedNodes.length) {
    const task = newTask(
      `▶️ Chạy tiếp từ checkpoint — bỏ qua ${resumedNodes.length} bước đã xong: ${resumedNodes.map(nodeTitle).join(", ")}`,
      "resume"
    );
    task.status = "done";
    run.tasks.push(task);
    emit({ runId, taskId: task.id, type: "task-created", task });
  }

  let guard = 0;
  while (true) {
    // Checked before scheduling anything new: stopRun() kills whatever is running, but the
    // graph also has to stop handing out the work that hasn't started yet.
    if (isCancelling(runId)) {
      run.status = "cancelled";
      emit({ runId, type: "run-status", status: "cancelled" });
      return;
    }

    if (++guard > nodes.length * 4 + 20) {
      run.status = "error";
      emit({ runId, type: "run-status", status: "error", error: "Workflow graph không hợp lệ (có thể có vòng lặp)." });
      return;
    }

    // Resolve skips to a fixed point: a node whose incoming edges are all resolved but
    // none are active (e.g. every parent skipped, or a router sent flow elsewhere) is itself skipped.
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of nodes) {
        if (state.get(n.id) !== "pending") continue;
        const inc = incomingOf.get(n.id);
        if (!inc.length) continue; // root node — never auto-skipped
        if (!inc.every(edgeSourceResolved)) continue;
        if (!inc.some(edgeActive)) {
          state.set(n.id, "skipped");
          const task = newTask(nodeTitle(n), n.kind === "router" ? "workflow-router" : "workflow-node", n.id);
          task.status = "skipped";
          run.tasks.push(task);
          taskIdByNode.set(n.id, task.id);
          emit({ runId, taskId: task.id, type: "task-created", task });
          emit({ runId, taskId: task.id, type: "task-status", status: "skipped" });
          checkpointNode(n.id);
          changed = true;
        }
      }
    }

    const ready = nodes.filter((n) => {
      if (state.get(n.id) !== "pending") return false;
      const inc = incomingOf.get(n.id);
      if (!inc.length) return true;
      return inc.every(edgeSourceResolved) && inc.some(edgeActive);
    });

    if (!ready.length) {
      const stillPending = nodes.some((n) => state.get(n.id) === "pending");
      if (stillPending) {
        run.status = "error";
        emit({ runId, type: "run-status", status: "error", error: "Workflow graph không hợp lệ (bế tắc)." });
      } else {
        const anyError = nodes.some((n) => ["error", "cancelled"].includes(state.get(n.id)));
        run.status = anyError ? "error" : "done";
        emit({ runId, type: "run-status", status: run.status });
      }
      return;
    }

    for (const n of ready) state.set(n.id, "running");

    // Every node runs away from the checked-out branch. This makes the final diff reviewable
    // and declineable for linear workflows too, not only for parallel fan-out batches.
    const isolateBatch = !!workspace;

    // Created up-front, before any agent starts, so every branch of the fan-out begins from
    // the same HEAD — not from whatever an earlier sibling happened to have merged already.
    const batch = [];
    for (const n of ready) {
      const nodeAgent = agentForNode(n);
      const task = newTask(nodeTitle(n), n.kind === "router" ? "workflow-router" : "workflow-node", n.id, nodeAgent);
      run.tasks.push(task);
      taskIdByNode.set(n.id, task.id);
      emit({ runId, taskId: task.id, type: "task-created", task });

      const wt = isolateBatch
        ? await createWorktree(workspace.session, n.id, (line) => pushTaskLog(runId, task.id, line))
        : null;
      batch.push({ node: n, task, agent: nodeAgent, wt, cwd: wt ? wt.dir : cwd });
    }

    await Promise.all(
      batch.map(async ({ node: n, task, agent, wt, cwd: nodeCwd }) => {
        if (workspace && !wt) {
          state.set(n.id, "error");
          task.status = "error";
          pushTaskLog(runId, task.id, "❌ Không tạo được workspace riêng; đã dừng để bảo vệ nhánh chính.");
          emit({ runId, taskId: task.id, type: "task-status", status: "error" });
          checkpointNode(n.id);
          return;
        }
        const inc = incomingOf.get(n.id).filter(edgeActive);
        const inputs = inc.map((e) => ({ title: nodeTitle(nodeById.get(e.from)), text: output.get(e.from) || "" }));
        let nodePrompt =
          n.teamRole === "coordinator" ? buildCoordinatorPrompt(n.promptTemplate, prompt) : buildNodePrompt(n.promptTemplate, prompt, inputs);
        if (n.kind === "router") nodePrompt += routeInstruction(outgoingOf.get(n.id));

        task.status = "running";
        emit({ runId, taskId: task.id, type: "task-status", status: "running" });

        const { ok, resultText, usage, sessionId } = await runAgentProcess({
          runId,
          taskId: task.id,
          prompt: nodePrompt,
          cwd: nodeCwd,
          agent,
          node: n,
          workflow,
        });

        task.resultText = resultText;
        task.usage = usage;
        task.sessionId = sessionId || null;
        output.set(n.id, resultText);

        if (!ok) {
          // A CLI that exited non-zero *because we killed it* isn't a failure to report as one
          // — it's the stop the user asked for, and it must not be checkpointed as a node that
          // was tried and failed, or resume would treat it as re-runnable for the wrong reason.
          const cancelled = isCancelling(runId);
          state.set(n.id, cancelled ? "cancelled" : "error");
          task.status = cancelled ? "cancelled" : "error";
          emit({ runId, taskId: task.id, type: "task-status", status: task.status });
          checkpointNode(n.id);
          return;
        }

        if (n.kind === "router") {
          const outgoing = outgoingOf.get(n.id);
          const { edge: chosen, label } = pickRoute(resultText, outgoing);
          if (!chosen) {
            // No guessing: a router that didn't name a real branch fails, and its branches get skipped.
            const valid = outgoing.map((e) => e.condition).join(", ");
            pushTaskLog(
              runId,
              task.id,
              label === null
                ? `❌ Router không trả về dòng "ROUTE: <nhãn>". Nhãn hợp lệ: ${valid}`
                : `❌ Router trả về nhãn "${label}" không khớp nhánh nào. Nhãn hợp lệ: ${valid}`
            );
            state.set(n.id, "error");
            task.status = "error";
            emit({ runId, taskId: task.id, type: "task-status", status: "error" });
            checkpointNode(n.id);
            return;
          }
          routerChoice.set(n.id, chosen.id);
          pushTaskLog(runId, task.id, `🔀 ROUTE: ${chosen.condition} → ${nodeTitle(nodeById.get(chosen.to))}`);
        }

        state.set(n.id, "done");
        task.status = "done";
        emit({ runId, taskId: task.id, type: "task-status", status: "done" });
        checkpointNode(n.id);
      })
    );

    // Commit → test → merge → clean up, ONE branch at a time: `git merge` takes the repo's
    // index lock, and each merge has to see the result of the previous one to detect a real
    // conflict between two siblings. A branch that fails its tests or conflicts flips its node
    // to "error" here, so downstream steps get skipped instead of building on work that never
    // actually landed on the base branch.
    //
    // On a stop, the branches are torn down instead: testing and merging work the user just
    // cancelled would be exactly the surprise they were trying to avoid. The worktrees are kept
    // or dropped by the same keepOnFailure setting, so whatever the agents did is still there
    // to look at.
    const stopping = isCancelling(runId);
    for (const { node: n, task, wt } of batch) {
      if (!wt) continue;
      const agentFailed = stopping || state.get(n.id) === "error";
      if (stopping) pushTaskLog(runId, task.id, "🛑 Run bị dừng — bỏ qua kiểm thử và gộp nhánh cho không gian riêng này.");
      const { ok } = await integrateWorktree(workspace.session, wt, {
        title: `${nodeTitle(n)} (${runId})`,
        agentFailed,
        log: (line) => pushTaskLog(runId, task.id, line),
      });
      if (!ok && workspace.session.keepOnFailure) keptDirs.push(wt.dir);
      if (!ok && !agentFailed) {
        state.set(n.id, "error");
        task.status = "error";
        emit({ runId, taskId: task.id, type: "task-status", status: "error" });
        checkpointNode(n.id);
      }
    }
  }
}

/** --------------------------- continuing a finished run as a chat --------------------------- */

const LEAD_KINDS_SINGLE = ["agent", "followup"];
const LEAD_KINDS_WORKFLOW = ["workflow-node", "workflow-router", "followup"];
const TRANSCRIPT_MAX_CHARS = 20000;

/**
 * Who a follow-up message goes to: the agent of a single-agent run; a Team's coordinator (with the
 * team's spawn_agent setting, and its members reachable through ask_agent as before); for a
 * Pipeline, the step that finished last — the end of the flow the user just read.
 * The workflow is the run's own snapshot, so later edits to the workflow don't leak in.
 */
function chatLead(run) {
  if (!run.workflowId) {
    const agent = getAgent(run.agentId);
    return agent?.id === run.agentId ? { agent, node: null, workflow: null } : null;
  }
  const workflow = snapshotWorkflow(run);
  let node = null;
  if (run.workflowType === "team") {
    node = workflow.nodes.find((n) => n.teamRole === "coordinator") || null;
  } else {
    for (let i = run.tasks.length - 1; i >= 0 && !node; i--) {
      const t = run.tasks[i];
      if (t.status === "done" && t.nodeId && LEAD_KINDS_WORKFLOW.includes(t.kind)) node = workflow.nodes.find((n) => n.id === t.nodeId) || null;
    }
  }
  if (!node) return null;
  const agent = agentForNode(node);
  return agent ? { agent, node, workflow } : null;
}

/** The lead's earlier turns in this run: what a follow-up continues from. */
function leadTasks(run, node) {
  return run.tasks.filter((t) => (node ? t.nodeId === node.id && LEAD_KINDS_WORKFLOW.includes(t.kind) : LEAD_KINDS_SINGLE.includes(t.kind)));
}

/** For a lead whose CLI session can't be resumed: the conversation so far, then the new message. */
function chatTranscript(run, earlier, message) {
  const parts = [`Yêu cầu ban đầu của người dùng:\n${run.prompt}`];
  for (const t of earlier) {
    if (t.kind === "followup") parts.push(`Người dùng hỏi tiếp:\n${t.userMessage || t.title}`);
    if (t.resultText) parts.push(`Bạn đã trả lời:\n${t.resultText}`);
  }
  let history = parts.join("\n\n---\n\n");
  if (history.length > TRANSCRIPT_MAX_CHARS) history = `…${history.slice(-TRANSCRIPT_MAX_CHARS)}`;
  return `${history}\n\n---\n\nTin nhắn mới của người dùng (tiếp tục cuộc trò chuyện ở trên):\n${message}`;
}

/**
 * Sends a follow-up message to a finished run's lead agent, as a new "followup" task in the same
 * run. Claude and agy resume their own CLI session (same working folder, so Claude finds it);
 * anything else — or a resume that fails — gets the conversation so far as a transcript instead.
 *
 * Refused while the run is still going. Changes still waiting for Accept/Decline don't block it:
 * the review branch is kept until that decision, so the turn reopens it and keeps editing the
 * unaccepted code (openWorkspaceSession reuses an existing review branch), and the review it ends
 * with covers everything since the original base — one Accept takes all the turns at once.
 */
function continueRun(runId, message) {
  const run = runs.get(runId);
  if (!run) return false;
  message = String(message || "").trim();
  if (!message) throw new Error("Thiếu nội dung tin nhắn.");
  if (run.status === "running") throw new Error("Run đang chạy — đợi xong rồi mới chat tiếp.");
  const lead = chatLead(run);
  if (!lead) throw new Error("Run này không còn agent nào để chat tiếp (agent đã bị xoá hoặc chưa có bước nào chạy xong).");

  cancelling.delete(runId);
  run.status = "running";
  run.error = null;
  run.lastActivityAt = Date.now();
  emit({ runId, type: "run-status", status: "running" });
  process.nextTick(() =>
    executeFollowUp(run, lead, message).catch((err) => {
      run.status = "error";
      run.error = err.message;
      cancelling.delete(runId);
      emit({ runId, type: "run-status", status: "error", error: err.message });
    })
  );
  return true;
}

async function executeFollowUp(run, { agent, node, workflow }, message) {
  const runId = run.id;
  // The turn exists before anything else so every task it causes — its workspace task, hand-offs
  // to members, spawned agents — is tagged with it (turnId) and goes away with it on delete.
  const earlier = leadTasks(run, node);
  const task = newTask(message, "followup", node?.id || null, agent);
  task.userMessage = message;
  run.activeTurnId = task.id;

  const { workspace, fatal } = await openRunWorkspace(run, { isolation: workflow?.isolation || {} });
  if (!workspace && fatal) {
    run.activeTurnId = null;
    run.status = "error";
    run.error = run.review?.reason;
    cancelling.delete(runId);
    emit({ runId, type: "run-status", status: "error", error: run.error });
    return;
  }

  const keptDirs = [];
  try {
    run.tasks.push(task);
    emit({ runId, taskId: task.id, type: "task-created", task });
    task.status = "running";
    emit({ runId, taskId: task.id, type: "task-status", status: "running" });
    const log = (line) => pushTaskLog(runId, task.id, line);

    let cwd = run.cwd;
    let wt = null;
    if (workspace) {
      if (node) {
        wt = await createWorktree(workspace.session, node.id, log);
        if (!wt) throw new Error("Không tạo được workspace riêng cho lượt chat này.");
        cwd = wt.dir;
      } else cwd = workspace.session.reviewDir;
    }

    // Resume the newest earlier turn whose session doesn't contain a deleted turn (see deleteChat).
    const burned = new Set(run.burnedSessions || []);
    const previous = [...earlier].reverse().find((t) => t.sessionId && t.provider === task.provider && !burned.has(t.sessionId));
    const resume = previous && task.provider !== "codex" ? previous.sessionId : null;
    log(resume ? "↩️ Tiếp tục phiên trước của agent." : "↩️ Gửi kèm lịch sử cuộc trò chuyện (không có phiên CLI để mở lại).");
    const base = { runId, taskId: task.id, cwd, agent, node, workflow };
    let result = await runAgentProcess({ ...base, prompt: resume ? message : chatTranscript(run, earlier, message), resume });
    if (resume && !result.ok && !result.resultText && !isCancelling(runId)) {
      log("⚠️ Không mở lại được phiên cũ — gửi lại kèm lịch sử cuộc trò chuyện.");
      result = await runAgentProcess({ ...base, prompt: chatTranscript(run, earlier, message), resume: null });
    }

    task.resultText = result.resultText;
    task.usage = result.usage;
    task.sessionId = result.sessionId || resume || null;
    task.failureReason = result.failureReason || null;
    task.status = isCancelling(runId) ? "cancelled" : result.ok ? "done" : "error";
    emit({ runId, taskId: task.id, type: "task-status", status: task.status, usage: task.usage });

    if (wt) {
      const stopping = isCancelling(runId);
      const { ok } = await integrateWorktree(workspace.session, wt, {
        title: `${nodeTitle(node)} — chat (${runId})`,
        agentFailed: stopping || task.status !== "done",
        log,
      });
      if (!ok && workspace.session.keepOnFailure) keptDirs.push(wt.dir);
      if (!ok && task.status === "done") {
        task.status = "error";
        emit({ runId, taskId: task.id, type: "task-status", status: "error" });
      }
    }
    run.status = isCancelling(runId) ? "cancelled" : task.status === "done" ? "done" : "error";
  } finally {
    run.activeTurnId = null;
    cancelling.delete(runId);
    if (workspace) await finalizeRunReview(run, workspace, keptDirs);
  }
  emit({ runId, type: "run-status", status: run.status });
}

/**
 * Deletes one chat turn (`turnId`), or every chat turn of the run when it's omitted: the
 * follow-up task plus everything tagged with it (its workspace task, hand-offs, spawned agents),
 * and the work-item claims those hand-offs made, so the ids can be reused.
 *
 * The agent forgets the deleted turns too: their CLI sessions are "burned", and the next turn
 * resumes the newest session that isn't. Claude forks a new session per turn, so that's the turn
 * before; agy keeps one conversation for every turn, so after a delete it gets a transcript of
 * what's left instead. Code changes a turn made are not undone.
 */
function deleteChat(runId, turnId = null) {
  const run = runs.get(runId);
  if (!run) return false;
  if (run.status === "running") throw new Error("Run đang chạy — dừng hoặc đợi xong rồi mới xoá chat.");
  const turns = run.tasks.filter((t) => t.kind === "followup" && (!turnId || t.id === turnId));
  if (!turns.length) throw new Error(turnId ? "Không tìm thấy lượt chat này." : "Run này chưa có lượt chat nào.");

  const turnIds = new Set(turns.map((t) => t.id));
  const removed = new Set(run.tasks.filter((t) => turnIds.has(t.id) || turnIds.has(t.turnId)).map((t) => t.id));
  run.burnedSessions = [...new Set([...(run.burnedSessions || []), ...turns.map((t) => t.sessionId).filter(Boolean)])];
  run.tasks = run.tasks.filter((t) => !removed.has(t.id));
  if (Array.isArray(run.delegations)) run.delegations = run.delegations.filter((d) => !removed.has(d.id)); // record id = assignment task id
  emit({ runId, type: "run-updated" });
  return true;
}

export { startRun, startWorkflowRun, stopRun, resumeRun, continueRun, deleteChat, askAgent, spawnAgent };
