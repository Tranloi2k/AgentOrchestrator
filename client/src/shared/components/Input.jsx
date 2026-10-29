import React from "react";
import { DetailField } from "./DetailLayout.jsx";

export function TextInput({ label, full, id, className = "", ...props }) {
  const input = <input type="text" id={id} className={className} {...props} />;
  if (label) {
    return (
      <DetailField label={label} full={full} htmlFor={id}>
        {input}
      </DetailField>
    );
  }
  return input;
}

export function Select({ label, full, id, options, placeholder, children, className = "", ...props }) {
  const select = (
    <select id={id} className={className} {...props}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options
        ? options.map((opt) => (
            <option key={opt.value} value={opt.value} disabled={opt.disabled} title={opt.title}>
              {opt.label}
            </option>
          ))
        : children}
    </select>
  );

  if (label) {
    return (
      <DetailField label={label} full={full} htmlFor={id}>
        {select}
      </DetailField>
    );
  }
  return select;
}

export function Textarea({ label, full, id, size, className = "", ...props }) {
  const classes = [size === "lg" ? "detail-textarea-lg" : "", className].filter(Boolean).join(" ");
  const textarea = <textarea id={id} className={classes || undefined} {...props} />;

  if (label) {
    return (
      <DetailField label={label} full={full} htmlFor={id}>
        {textarea}
      </DetailField>
    );
  }
  return textarea;
}
