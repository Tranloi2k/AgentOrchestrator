import React from "react";

export function DetailSection({ title, description, children }) {
  return (
    <section className="detail-section">
      <div className="detail-section-header">
        <h3 className="detail-section-title">{title}</h3>
        {description && <p className="detail-section-desc">{description}</p>}
      </div>
      <div className="detail-section-body">{children}</div>
    </section>
  );
}

export function DetailField({ label, children, full, htmlFor }) {
  return (
    <div className={`detail-field ${full ? "detail-field-full" : ""}`}>
      {label && <label htmlFor={htmlFor}>{label}</label>}
      {children}
    </div>
  );
}

export function DetailFieldGrid({ children }) {
  return <div className="detail-field-grid">{children}</div>;
}
