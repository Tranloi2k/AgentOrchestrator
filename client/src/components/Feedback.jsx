import React from "react";

export function ErrorBox({ className = "", children }) {
  if (!children) return null;
  return <div className={`error-box ${className}`.trim()}>{children}</div>;
}

export function InfoBanner({ children }) {
  if (!children) return null;
  return <div className="info-banner">{children}</div>;
}

export function HelperText({ className = "", children }) {
  if (!children) return null;
  return <div className={`flow-desc ${className}`.trim()}>{children}</div>;
}
