import React from "react";
import Button from "./Button.jsx";
import { InfoTip } from "./Feedback.jsx";

// The page title lives in the app header; this bar only carries the page's actions (and an optional tip).
export default function TabPageHeader({ hint, actionLabel, onAction, actionDisabled, children }) {
  return (
    <div className="tab-content-header">
      <InfoTip>{hint}</InfoTip>
      {children}
      {actionLabel && (
        <Button variant="primary" onClick={onAction} disabled={actionDisabled}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
