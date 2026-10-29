/** Token arithmetic over task usage records (see normalizeClaudeUsage in cli-runners.js). No I/O. */

/** Tokens a usage record counts against a budget: input + output + cache writes (as spawn_agent). */
export const usageTokens = (u) => (u ? (u.inputTokens || 0) + (u.outputTokens || 0) + (u.cacheCreationTokens || 0) : 0);

/** Sum of two usage records: a node's attempts (retries, failover) all land on its one task. */
export function addUsage(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const sum = (k) => (a[k] || 0) + (b[k] || 0);
  return {
    provider: b.provider || a.provider,
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    cacheReadTokens: sum("cacheReadTokens"),
    cacheCreationTokens: sum("cacheCreationTokens"),
    costUsd: typeof a.costUsd === "number" || typeof b.costUsd === "number" ? (a.costUsd || 0) + (b.costUsd || 0) : null,
    durationMs: sum("durationMs"),
  };
}

export const runTokens = (run) => run.tasks.reduce((n, t) => n + usageTokens(t.usage), 0);
