import React, { useEffect, useRef, useState } from "react";
import { api } from "../api.js";
import { usePreferences } from "../../app/PreferencesContext.jsx";
import Button from "./Button.jsx";
import { Select } from "./Input.jsx";
import { ErrorBox, HelperText } from "./Feedback.jsx";
import { DetailField, DetailFieldGrid } from "./DetailLayout.jsx";

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
export default function AssistantPanel({ target, draft, onApply, onUndo, canUndo, formatErrors }) {
  const { t } = usePreferences();
  const [collapsed, setCollapsed] = useState(false);
  const [meta, setMeta] = useState(null);
  const [choice, setChoice] = useState({ provider: "", model: "" });
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
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

  if (collapsed) {
    return (
      <Button variant="secondary" className="assistant-expand" onClick={() => setCollapsed(false)}>
        ✨ {t("assistant.title")}
      </Button>
    );
  }

  const lastApplied = messages.map((m, i) => (m.applied ? i : -1)).reduce((a, b) => Math.max(a, b), -1);

  return (
    <section className="detail-section assistant-panel">
      <div className="detail-section-header assistant-head">
        <h3 className="detail-section-title">✨ {t("assistant.title")}</h3>
        <span className="assistant-head-actions">
          {messages.length > 0 && !busy && (
            <button type="button" className="run-chat-clear" onClick={() => setMessages([])}>
              {t("assistant.clear")}
            </button>
          )}
          <Button variant="icon" onClick={() => setCollapsed(true)} title={t("assistant.collapse")} aria-label={t("assistant.collapse")}>
            »
          </Button>
        </span>
      </div>

      <div className="detail-section-body assistant-body">
        {meta && !installed.length ? (
          <HelperText>{t("assistant.noCli")}</HelperText>
        ) : (
          <DetailFieldGrid>
            <DetailField>
              <Select
                title={t("assistant.cli")}
                value={choice.provider}
                onChange={(e) => pick({ provider: e.target.value, model: "" })}
                options={installed.map((p) => ({ value: p, label: t(`agents.provider.${p}`) }))}
              />
            </DetailField>
            <DetailField>
              <Select
                title={t("assistant.model")}
                value={choice.model}
                onChange={(e) => pick({ ...choice, model: e.target.value })}
                options={modelsOf(meta, choice.provider).map((m) => ({ value: m.value, label: m.label }))}
              />
            </DetailField>
          </DetailFieldGrid>
        )}

        {(messages.length > 0 || busy) && (
          <div className="assistant-messages" ref={listRef}>
            {messages.map((m, i) => (
              <div key={i} className={`assistant-msg assistant-msg-${m.role}${m.failed ? " assistant-msg-failed" : ""}`}>
                {m.content && <div className="assistant-msg-text">{m.content}</div>}
                {m.parseError && <div className="assistant-msg-note">{t("assistant.parseError")}</div>}
                {m.applied && (
                  <div className="assistant-msg-note">
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
            ))}
            {busy && <div className="assistant-msg assistant-msg-assistant assistant-msg-pending">{t("assistant.thinking")}</div>}
          </div>
        )}

        <DetailField>
          <textarea
            value={input}
            disabled={busy || !ready}
            placeholder={t(`assistant.placeholder.${target}`)}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                send();
              }
            }}
          />
        </DetailField>
        <div className="assistant-actions">
          <Button variant="primary" disabled={!input.trim() || busy || !ready} onClick={send}>
            {busy ? "..." : t("assistant.send")}
          </Button>
        </div>
        <ErrorBox>{error}</ErrorBox>
      </div>
    </section>
  );
}
