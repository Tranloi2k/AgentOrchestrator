import React from "react";

/**
 * Segmented control — mode toggle pattern.
 */
export default function SegmentedControl({ options, value, onChange, className = "mode-toggle" }) {
  return (
    <div className={className}>
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={value === opt.value ? "active" : ""}
          onClick={() => onChange(opt.value)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}
