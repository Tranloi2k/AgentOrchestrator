import React from "react";
import { HelperText } from "./Feedback.jsx";

/**
 * Multi-select pill toggle (tool-chip pattern).
 */
export default function ChipSelect({ options = [], selected = [], onChange, nameStyle = false, emptyMessage }) {
  function toggle(value) {
    const next = selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value];
    onChange(next);
  }

  if (!options.length) {
    return emptyMessage ? <HelperText>{emptyMessage}</HelperText> : null;
  }

  return (
    <div className="tool-grid">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={`tool-chip ${nameStyle ? "tool-chip-name" : ""} ${selected.includes(opt.value) ? "selected" : ""}`}
          title={opt.title}
          onClick={() => toggle(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
