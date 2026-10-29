const FAILOVER_REASONS = new Set(["quota", "provider_unavailable"]);

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
  const scope = ledger.filter((entry) => entry.callerNodeId === callerNodeId);
  const attempts = scope.filter((entry) => entry.workItemId === itemId);
  const lastAttempt = attempts.at(-1);

  if (lastAttempt?.status === "running") {
    throw new Error(`Công việc "${itemId}" đang được agent ${lastAttempt.targetNodeId} thực hiện; không được giao trùng.`);
  }

  if (lastAttempt && lastAttempt.targetNodeId !== targetNodeId) {
    if (lastAttempt.status !== "error" || !FAILOVER_REASONS.has(lastAttempt.failureReason)) {
      throw new Error(
        `Công việc "${itemId}" đã thuộc agent ${lastAttempt.targetNodeId}. Chỉ được đổi agent khi lần trước thất bại vì hết quota hoặc provider không khả dụng.`
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

function classifyAgentFailure({ providerAvailable = true, spawnError = null, exitCode = 0, stderr = "", resultText = "", quotaSignal = false } = {}) {
  if (!providerAvailable || spawnError?.code === "ENOENT") return "provider_unavailable";
  if (exitCode === 0) return null;

  const text = `${stderr}\n${resultText}\n${spawnError?.message || ""}`.toLocaleLowerCase();
  if (
    quotaSignal ||
    /(?:rate[\s_-]*limit|usage[\s_-]*limit|token[\s_-]*limit|request[\s_-]*limit|quota|resource[\s_-]*exhausted|credit balance|too many requests|http\s*429|status\s*429|(?:usage|quota|token|request) limit (?:has been )?(?:reached|exceeded)|resets? at)/i.test(text)
  ) {
    return "quota";
  }
  return "agent_error";
}

export { FAILOVER_REASONS, classifyAgentFailure, finishDelegation, questionFingerprint, reserveDelegation };
