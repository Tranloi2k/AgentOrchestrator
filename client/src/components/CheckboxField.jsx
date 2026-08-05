import React from "react";
import { HelperText } from "./Feedback.jsx";

export default function CheckboxField({ id, checked, onChange, label, hint, className = "" }) {
  return (
    <div className={className || undefined}>
      <div className="checkbox-row">
        <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <label htmlFor={id}>{label}</label>
      </div>
      {hint && <HelperText>{hint}</HelperText>}
    </div>
  );
}
