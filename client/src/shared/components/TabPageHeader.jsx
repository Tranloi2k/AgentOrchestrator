import React, { useEffect } from "react";
import Button from "./Button.jsx";
import { usePageMeta } from "../../app/PageMetaContext.jsx";

// The page title lives in the app header, and so does the page's tip (shown beside the title);
// this bar only carries the page's actions.
export default function TabPageHeader({ hint, actionLabel, onAction, actionDisabled, children }) {
  const { setHint } = usePageMeta();

  useEffect(() => {
    setHint(hint || null);
    return () => setHint(null);
  }, [hint, setHint]);

  return (
    <div className="tab-content-header">
      {children}
      {actionLabel && (
        <Button variant="primary" onClick={onAction} disabled={actionDisabled}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
