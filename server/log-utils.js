const NOISY_LOG_TOKENS = new Set([
    "thinking_tokens",
    "init",
    "post_turn_summary",
    "tool_result",
    "tool_use",
]);

function normalizeLogLine(line) {
    return String(line || "").trim();
}

function shouldRenderLogLine(line) {
    const normalized = normalizeLogLine(line);
    if (!normalized) return false;

    const isInfoEvent = normalized.startsWith("ℹ") || normalized.startsWith("ℹ️") || normalized.startsWith("info");
    if (isInfoEvent) {
        const payload = normalized.replace(/^ℹ️?\s*/, "").trim();
        const label = payload.split(/\s+/)[0]?.toLowerCase();
        return !NOISY_LOG_TOKENS.has(label);
    }

    return true;
}

export { shouldRenderLogLine };
