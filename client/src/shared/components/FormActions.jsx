import React from "react";

export default function FormActions({ className = "", children }) {
  return <div className={`form-actions ${className}`.trim()}>{children}</div>;
}
