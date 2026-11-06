import React, { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { usePreferences } from "../../app/PreferencesContext.jsx";
import { IconClose, IconSend, IconSparkle } from "../Icons.jsx";
import { ErrorBox, HelperText } from "./Feedback.jsx";

const STORAGE_KEY = "assistant.cli";
const PROVIDERS = ["claude", "codex", "gemini"];

function modelsOf(meta, provider) {
  return (provider === "codex" ? meta?.codexModels : provider === "gemini" ? meta?.geminiModels : meta?.models) || [];
}

/** The last CLI + model picked here, if still installed; else the first installed CLI on its default model. */
function initialChoice(meta) {
  const installed = PROVIDERS.filter((p) => meta.providerAvailability?.[p]);
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (saved && installed.includes(saved.provider)) return { provider: saved.provider, model: String(saved.model || "") };
  } catch {
    /* ignore a corrupt value */
  }
  return { provider: installed[0] || "", model: "" };
}

/**
 * AI chat beside the Workflow / Agent form. A CLI installed on this machine answers (picked here
 * with its model — not a saved agent); a config it proposes goes straight into the form through
 * `onApply` (never saved here — the user reviews and saves). `formatErrors` turns the server's
 * validation errors into lines, at render time so they name nodes as the form currently does.
 */
export default function AssistantPanel({ target, draft, onApply, onUndo, canUndo, formatErrors, onClose }) {
  const { t } = usePreferences();
  const [meta, setMeta] = useState(null);
  const [choice, setChoice] = useState({ provider: "", model: "" });
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [waited, setWaited] = useState(0); // seconds the current answer has taken so far
  const [error, setError] = useState("");
  const listRef = useRef(null);

  useEffect(() => {
    api.meta().then((d) => {
      setMeta(d);
      setChoice(initialChoice(d));
    });
  }, []);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, busy]);

  // A CLI answer takes a while; count the seconds so a slow reply doesn't look like a dead panel.
  useEffect(() => {
    if (!busy) return undefined;
    setWaited(0);
    const timer = setInterval(() => setWaited((s) => s + 1), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  function pick(next) {
    setChoice(next);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }

  const ready = !!choice.provider;
  const installed = PROVIDERS.filter((p) => meta?.providerAvailability?.[p]);

  async function send() {
    const text = input.trim();
    if (!text || busy || !ready) return;
    const history = [...messages, { role: "user", content: text }];
    setMessages(history);
    setInput("");
    setBusy(true);
    setError("");
    try {
      const res = await api.askAssistant({
        target,
        provider: choice.provider,
        model: choice.model,
        draft,
        messages: history.filter((m) => !m.failed).map(({ role, content }) => ({ role, content })),
      });
      if (res.failureReason) {
        setMessages((m) => [...m, { role: "assistant", content: t("assistant.failed", { reason: res.failureReason }), failed: true }]);
        return;
      }
      if (res.proposal) onApply(res.proposal);
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: res.reply || "",
          applied: !!res.proposal,
          errors: res.errors || [],
          parseError: !!res.parseError,
        },
      ]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const lastApplied = messages.map((m, i) => (m.applied ? i : -1)).reduce((a, b) => Math.max(a, b), -1);
  const canSend = !!input.trim() && !busy && ready;

  return (
    <section className="assistant-panel" aria-label={t("assistant.title")}>
      <header className="assistant-head">
        <span className="assistant-head-title">
          <span className="assistant-head-icon">
            <IconSparkle size={14} />
          </span>
          {t("assistant.title")}
        </span>
        <span className="assistant-head-actions">
          {messages.length > 0 && !busy && (
            <button type="button" className="assistant-head-btn" onClick={() => setMessages([])} title={t("assistant.clear")}>
              {t("assistant.clear")}
            </button>
          )}
          {onClose && (
            <button
              type="button"
              className="assistant-head-btn assistant-close"
              onClick={onClose}
              title={`${t("assistant.close")} (Ctrl+J)`}
              aria-label={t("assistant.close")}
            >
              <IconClose size={12} />
            </button>
          )}
        </span>
      </header>

      {meta && !installed.length ? (
        <div className="assistant-config">
          <HelperText>{t("assistant.noCli")}</HelperText>
        </div>
      ) : (
        <div className="assistant-config">
          <select
            className="assistant-select"
            title={t("assistant.cli")}
            aria-label={t("assistant.cli")}
            value={choice.provider}
            onChange={(e) => pick({ provider: e.target.value, model: "" })}
          >
            {installed.map((p) => (
              <option key={p} value={p}>
                {t(`agents.provider.${p}`)}
              </option>
            ))}
          </select>
          <select
            className="assistant-select"
            title={t("assistant.model")}
            aria-label={t("assistant.model")}
            value={choice.model}
            onChange={(e) => pick({ ...choice, model: e.target.value })}
          >
            {modelsOf(meta, choice.provider).map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="assistant-messages" ref={listRef}>
        {!messages.length && !busy ? (
          <div className="assistant-empty">
            <span className="assistant-empty-icon">
              <IconSparkle size={18} />
            </span>
            <p>{t(`assistant.empty.${target}`)}</p>
          </div>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`assistant-msg assistant-msg-${m.role}${m.failed ? " assistant-msg-failed" : ""}`}>
              {m.content && <div className="assistant-msg-text">{m.content}</div>}
              {m.parseError && <div className="assistant-msg-note">{t("assistant.parseError")}</div>}
              {m.applied && (
                <div className="assistant-msg-note assistant-msg-applied">
                  {t("assistant.applied")}
                  {i === lastApplied && canUndo && (
                    <button type="button" className="assistant-undo" onClick={onUndo}>
                      {t("assistant.undo")}
                    </button>
                  )}
                </div>
              )}
              {m.errors?.length > 0 && (
                <ul className="assistant-msg-errors">
                  {(formatErrors ? formatErrors(m.errors) : m.errors.map((e) => e.code)).map((line, j) => (
                    <li key={j}>{line}</li>
                  ))}
                </ul>
              )}
            </div>
          ))
        )}
        {busy && (
          <div className="assistant-msg assistant-msg-assistant assistant-msg-pending">
            <span className="assistant-typing" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            {t("assistant.thinking", { sec: waited })}
          </div>
        )}
      </div>

      <div className="assistant-composer">
        <ErrorBox>{error}</ErrorBox>
        <div className={`assistant-input ${busy || !ready ? "is-disabled" : ""}`}>
          <textarea
            rows={3}
            value={input}
            disabled={busy || !ready}
            placeholder={t(`assistant.placeholder.${target}`)}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, Shift+Enter is a new line; not while an IME is still composing.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="assistant-input-bar">
            <span className="assistant-input-hint">{t("assistant.enterHint")}</span>
            <button
              type="button"
              className="assistant-send"
              disabled={!canSend}
              onClick={send}
              title={t("assistant.send")}
              aria-label={t("assistant.send")}
            >
              <IconSend size={14} />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
