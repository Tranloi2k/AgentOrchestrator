/**
 * Failure reasons that say "this provider can't take calls right now": the provider is put on a
 * cooldown for the run (team-calls.js), so later calls skip it too.
 */
const COOLDOWN_REASONS = new Set(["quota", "provider_unavailable"]);

/**
 * Failure reasons that say "this provider can't do this job here", not "the task is wrong": the
 * next agent or provider may take the same work item. Only COOLDOWN_REASONS also sideline the
 * provider; the others are about one job, and the same provider may manage a different one.
 *  - tool_denied:            headless mode auto-denied a tool the job needed
 *  - no_output:              the process ended without a result message
 *  - capability_unavailable: the provider has no tool for what was asked (e.g. image generation)
 */
const FAILOVER_REASONS = new Set([...COOLDOWN_REASONS, "tool_denied", "no_output", "capability_unavailable"]);

/**
 * Failover reasons the server does not act on by itself inside a Team: the agent's answer goes
 * back to the coordinator, which knows the job and decides (another member or blueprint, a changed
 * request such as an SVG instead of a bitmap, or a note to the user). Being in FAILOVER_REASONS
 * still lets the coordinator move the work item to another member.
 */
const HANDED_BACK_REASONS = new Set(["capability_unavailable"]);

/** A failure reason in plain words, for task logs. */
const FAILURE_WORDS = {
  quota: "hết quota",
  provider_unavailable: "CLI không khả dụng",
  tool_denied: "bị từ chối quyền dùng tool (chế độ headless không hỏi được người dùng)",
  no_output: "kết thúc mà không trả về kết quả",
  capability_unavailable: "không có tool cho việc được giao",
  timeout: "hết thời gian",
  cancelled: "bị dừng",
  agent_error: "lỗi khi làm việc",
};

function describeFailure(reason) {
  return FAILURE_WORDS[reason] || FAILURE_WORDS.agent_error;
}

function cleanId(value) {
  return String(value || "").trim().slice(0, 80);
}

function questionFingerprint(question) {
  return String(question || "")
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function delegationLedger(run) {
  if (!Array.isArray(run.delegations)) run.delegations = [];
  return run.delegations;
}

/**
 * Reserves one logical work item for one target node before the CLI starts.
 *
 * A different target may take over the same work item only after the previous attempt failed
 * for a machine-detected quota/provider-availability reason. Distinct work is allowed only when
 * the caller explicitly gives it a parent, making the split visible and auditable in the run.
 */
function reserveDelegation(run, {
  callerNodeId,
  targetNodeId,
  workItemId,
  parentWorkItemId,
  question,
  assignmentId,
}) {
  const itemId = cleanId(workItemId);
  const parentId = cleanId(parentWorkItemId);
  if (!itemId) throw new Error("ask_agent cần workItemId để bảo đảm một công việc chỉ giao cho một agent.");
  if (parentId && parentId === itemId) throw new Error("parentWorkItemId phải khác workItemId.");

  const ledger = delegationLedger(run);
  // Blueprint spawns share the ledger (for sessions and replay) but have their own work items.
  const scope = ledger.filter((entry) => entry.callerNodeId === callerNodeId && entry.kind !== "spawn");
  const attempts = scope.filter((entry) => entry.workItemId === itemId);
  const lastAttempt = attempts.at(-1);

  if (lastAttempt?.status === "running") {
    throw new Error(`Công việc "${itemId}" đang được agent ${lastAttempt.targetNodeId} thực hiện; không được giao trùng.`);
  }

  if (lastAttempt && lastAttempt.targetNodeId !== targetNodeId) {
    if (lastAttempt.status !== "error" || !FAILOVER_REASONS.has(lastAttempt.failureReason)) {
      throw new Error(
        `Công việc "${itemId}" đã thuộc agent ${lastAttempt.targetNodeId}. Chỉ được đổi agent khi lần trước thất bại vì provider không làm được việc này (hết quota, CLI không khả dụng, tool bị từ chối, không có kết quả, không có tool phù hợp).`
      );
    }
  }

  if (!lastAttempt) {
    const topLevelItems = new Set(scope.filter((entry) => !entry.parentWorkItemId).map((entry) => entry.workItemId));
    if (!parentId && topLevelItems.size && !topLevelItems.has(itemId)) {
      throw new Error(
        `Đã có công việc gốc "${[...topLevelItems][0]}". Công việc mới "${itemId}" phải là subtask và khai báo parentWorkItemId.`
      );
    }
    if (parentId && parentId !== "root" && !scope.some((entry) => entry.workItemId === parentId)) {
      throw new Error(`Không tìm thấy công việc cha "${parentId}" trong các lần phân công của agent gọi.`);
    }

    const fingerprint = questionFingerprint(question);
    const duplicate = scope.find(
      (entry) =>
        entry.questionFingerprint === fingerprint &&
        entry.workItemId !== itemId &&
        entry.targetNodeId !== targetNodeId
    );
    if (fingerprint && duplicate) {
      throw new Error(
        `Nội dung này đã được giao cho agent ${duplicate.targetNodeId} dưới workItemId="${duplicate.workItemId}"; không được đổi mã để giao trùng cùng một việc.`
      );
    }
  }

  const record = {
    id: assignmentId,
    callerNodeId,
    targetNodeId,
    workItemId: itemId,
    parentWorkItemId: parentId || null,
    questionFingerprint: questionFingerprint(question),
    status: "running",
    failureReason: null,
    createdAt: Date.now(),
  };
  ledger.push(record);
  return record;
}

function finishDelegation(record, { ok, failureReason = null }) {
  record.status = ok ? "done" : "error";
  record.failureReason = ok ? null : failureReason || "agent_error";
  record.finishedAt = Date.now();
  return record;
}

// Headless permission auto-denial. agy: "auto-denied", "cannot prompt for", "requires the read_file
// permission"; Claude: "requested permissions to use X, but you haven't granted it yet"; Codex:
// "user cancelled MCP tool call" (no TTY to approve on). A bare "permission denied" is left out:
// that is usually the OS refusing a file, which is the task's problem, not the provider's.
const TOOL_DENIED_RE =
  /auto[\s_-]*denied|cannot prompt for|requir(?:e|es|ed) the [\w .:/()-]{1,60}? permission|requested permissions? to use|haven't granted it|user cancelled mcp tool call|tool (?:use|call) (?:was )?(?:denied|rejected)|denied by (?:the )?(?:permission|approval) (?:policy|mode)/i;

// The provider says it has no tool for what was asked.
const CAPABILITY_RE =
  /capability[\s_-]*unavailable|no (?:tool|capability) (?:is )?(?:available )?(?:for|to)|image generation (?:is )?not (?:available|supported)|(?:cannot|can't|unable to) (?:generate|create|produce) (?:an? )?images?|no image generation (?:tool|capability)/i;

const NO_OUTPUT_RE = /no output produced|produced no output|without (?:a )?result message/i;

/**
 * Why an agent process failed, or null when it didn't. Extra signals from the stream parsers:
 *  - quotaSignal:  a rate-limit event said the quota is used up (Claude)
 *  - deniedSignal: tools were denied and nothing else came out (agy denied_actions, Claude
 *                  permission_denials)
 *  - noResult:     the process ended without a result message; with exit code 0 this is still a
 *                  failure (no_output), not an empty success
 * A specific reason (quota, tool_denied, capability_unavailable) wins over no_output, and no_output
 * only applies when nothing else explains the exit: a crash that printed an error stays agent_error.
 */
function classifyAgentFailure({
  providerAvailable = true,
  spawnError = null,
  exitCode = 0,
  stderr = "",
  resultText = "",
  quotaSignal = false,
  deniedSignal = false,
  noResult = false,
} = {}) {
  if (!providerAvailable || spawnError?.code === "ENOENT") return "provider_unavailable";
  if (exitCode === 0 && !noResult && !deniedSignal) return null;

  const text = `${stderr}\n${resultText}\n${spawnError?.message || ""}`.toLocaleLowerCase();
  if (
    quotaSignal ||
    /(?:rate[\s_-]*limit|usage[\s_-]*limit|token[\s_-]*limit|request[\s_-]*limit|quota|resource[\s_-]*exhausted|credit balance|too many requests|http\s*429|status\s*429|(?:usage|quota|token|request) limit (?:has been )?(?:reached|exceeded)|resets? at)/i.test(text)
  ) {
    return "quota";
  }
  if (deniedSignal || TOOL_DENIED_RE.test(text)) return "tool_denied";
  if (CAPABILITY_RE.test(text)) return "capability_unavailable";
  if (NO_OUTPUT_RE.test(text) || (noResult && (exitCode === 0 || !String(stderr).trim()))) return "no_output";
  return "agent_error";
}

/**
 * What a member or spawned agent ends its answer with when it has no tool for the job, so the
 * server can hand the job to the next provider instead of passing a non-answer back.
 */
const CAPABILITY_MARKER = "CAPABILITY_UNAVAILABLE";
const CAPABILITY_INSTRUCTION =
  "Nếu bạn không có tool cần thiết cho việc này (ví dụ không tạo được ảnh) và hướng dẫn của bạn không nêu cách làm khác, " +
  `đừng làm một phần hay đoán: trả lời bằng một dòng \`${CAPABILITY_MARKER}: <thiếu tool gì>\`, kèm gợi ý ngắn cách làm khác nếu có. Người giao việc sẽ quyết định làm tiếp thế nào.`;

/** The `CAPABILITY_UNAVAILABLE: <what>` line of an answer (what is missing), or null. */
function parseCapabilityMarker(text) {
  const m = String(text || "").match(/^[ \t>*_`]*CAPABILITY_UNAVAILABLE[ \t]*:?[ \t]*(.*?)[ \t*_`]*$/im);
  return m ? m[1].trim() || "?" : null;
}

const UNIT_MS = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };
const unitMs = (unit) => {
  const u = unit.toLowerCase();
  if (u.startsWith("d")) return UNIT_MS.d;
  if (u.startsWith("h")) return UNIT_MS.h;
  if (u.startsWith("m")) return UNIT_MS.m;
  return UNIT_MS.s;
};

/**
 * When a provider's quota comes back, read off its error text: an epoch after "limit reached|"
 * (Claude Code), an ISO time, a duration ("try again in 2 days 3 hours", "retry in 41.5s",
 * "retryDelay": "41s") or a clock time ("resets 3pm", "try again at 15:30"). A clock time with no
 * date is the next time it comes round, in the server's local zone. Returns ms since the epoch,
 * or null when nothing in the text says.
 */
function parseQuotaReset(text, now = Date.now()) {
  const s = String(text || "");
  let m = s.match(/limit reached\|(\d{10,13})\b/i);
  if (m) return m[1].length === 13 ? Number(m[1]) : Number(m[1]) * 1000;

  m = s.match(/(?:reset|retry|try again)[^\n]{0,40}?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/i);
  if (m && !Number.isNaN(Date.parse(m[1]))) return Date.parse(m[1]);

  m = s.match(/retryDelay"?\s*:\s*"?(\d+(?:\.\d+)?)s/i);
  if (m) return now + Math.round(Number(m[1]) * 1000);

  const part = String.raw`\d+(?:\.\d+)?\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])`;
  m = s.match(new RegExp(String.raw`(?:try again|retry|resets?)\s+(?:in|after)\s+((?:${part}[\s,]*(?:and\s+)?)+)`, "i"));
  if (m) {
    let ms = 0;
    for (const p of m[1].matchAll(/(\d+(?:\.\d+)?)\s*([a-z]+)/gi)) ms += Number(p[1]) * unitMs(p[2]);
    if (ms > 0) return now + Math.round(ms);
  }

  m = s.match(/(?:resets?|try again)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?![\w:])/i);
  if (m && (m[2] || m[3])) {
    let hour = Number(m[1]) % 24;
    const minute = Number(m[2] || 0);
    if (m[3]) hour = (hour % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
    if (minute < 60) {
      const at = new Date(now);
      at.setHours(hour, minute, 0, 0);
      if (at.getTime() <= now) at.setDate(at.getDate() + 1);
      return at.getTime();
    }
  }
  return null;
}

export {
  CAPABILITY_INSTRUCTION,
  COOLDOWN_REASONS,
  FAILOVER_REASONS,
  HANDED_BACK_REASONS,
  classifyAgentFailure,
  describeFailure,
  finishDelegation,
  parseCapabilityMarker,
  parseQuotaReset,
  questionFingerprint,
  reserveDelegation,
};
