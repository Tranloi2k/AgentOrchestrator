import React from "react";
import { IconInfo } from "../Icons.jsx";

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

/** Long, static guidance tucked behind an (i) icon; shown on hover or keyboard focus. */
export function InfoTip({ children }) {
  if (!children) return null;
  return (
    <span className="info-tip" tabIndex={0} aria-label={typeof children === "string" ? children : undefined}>
      <IconInfo />
      <span className="info-tip-bubble" role="tooltip">
        {children}
      </span>
    </span>
  );
}
