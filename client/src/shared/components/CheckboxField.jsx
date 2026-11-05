import React from "react";
import { InfoTip } from "./Feedback.jsx";

export default function CheckboxField({ id, checked, onChange, label, hint, className = "" }) {
  return (
    <div className={className || undefined}>
      <div className="checkbox-row">
        <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <label htmlFor={id}>{label}</label>
        <InfoTip>{hint}</InfoTip>
      </div>
    </div>
  );
}
