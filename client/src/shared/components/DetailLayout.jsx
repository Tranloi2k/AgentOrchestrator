import React from "react";
import { InfoTip } from "./Feedback.jsx";

export function DetailSection({ title, description, children }) {
  return (
    <section className="detail-section">
      <div className="detail-section-header">
        <h3 className="detail-section-title">{title}</h3>
        <InfoTip>{description}</InfoTip>
      </div>
      <div className="detail-section-body">{children}</div>
    </section>
  );
}

export function DetailField({ label, hint, children, full, htmlFor }) {
  return (
    <div className={`detail-field ${full ? "detail-field-full" : ""}`}>
      {label && hint ? (
        <div className="detail-field-label">
          <label htmlFor={htmlFor}>{label}</label>
          <InfoTip>{hint}</InfoTip>
        </div>
      ) : (
        label && <label htmlFor={htmlFor}>{label}</label>
      )}
      {children}
    </div>
  );
}

export function DetailFieldGrid({ children }) {
  return <div className="detail-field-grid">{children}</div>;
}
