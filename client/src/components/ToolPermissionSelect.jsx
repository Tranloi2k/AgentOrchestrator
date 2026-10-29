import React from "react";
import { usePreferences } from "../PreferencesContext.jsx";

/**
 * Tool allowlist: a chosen tool may be used, every other tool is blocked. Two states only, so
 * there is no way to end up with a tool that is both allowed and denied.
 */
export default function ToolPermissionSelect({ options = [], allowed = [], onChange }) {
  const { t } = usePreferences();

  function toggle(value) {
    onChange(allowed.includes(value) ? allowed.filter((v) => v !== value) : [...allowed, value]);
  }

  return (
    <>
      <div className="tool-grid">
        {options.map((opt) => {
          const on = allowed.includes(opt.value);
          const state = on ? "allowed" : "denied";
          return (
            <button
              key={opt.value}
              type="button"
              className={`tool-chip tool-chip-${state}`}
              title={[opt.title, t(`tools.state.${state}`)].filter(Boolean).join(" — ")}
              aria-pressed={on}
              onClick={() => toggle(opt.value)}
            >
              <span className="tool-chip-mark">{on ? "✓" : "✕"}</span>
              {opt.label}
            </button>
          );
        })}
      </div>
      <div className="tool-legend">
        <span className="tool-legend-item">
          <span className="tool-legend-dot tool-chip-allowed">✓</span>
          {t("tools.state.allowed")}
        </span>
        <span className="tool-legend-item">
          <span className="tool-legend-dot tool-chip-denied">✕</span>
          {t("tools.state.denied")}
        </span>
        <span className="tool-legend-item">{t("tools.legend.hint")}</span>
      </div>
    </>
  );
}
