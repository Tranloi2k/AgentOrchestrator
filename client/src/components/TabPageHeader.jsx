import React from "react";
import Button from "./Button.jsx";

export default function TabPageHeader({ title, actionLabel, onAction, actionDisabled, children }) {
  return (
    <div className="tab-content-header">
      <h2>{title}</h2>
      {children}
      {actionLabel && (
        <Button variant="primary" onClick={onAction} disabled={actionDisabled}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
