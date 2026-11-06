import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { usePreferences } from "../../app/PreferencesContext.jsx";
import { usePageMeta } from "../../app/PageMetaContext.jsx";
import { IconSparkle } from "../Icons.jsx";
import Button from "./Button.jsx";
import ConfirmModal from "./ConfirmModal.jsx";
import { ErrorBox } from "./Feedback.jsx";

export { DetailSection, DetailField, DetailFieldGrid } from "./DetailLayout.jsx";

const ASIDE_OPEN_KEY = "detail.asideOpen";

function readAsideOpen() {
  try {
    return localStorage.getItem(ASIDE_OPEN_KEY) !== "0";
  } catch {
    return true;
  }
}

export default function DetailPage({
  breadcrumbs,
  title,
  subtitle,
  error,
  saving,
  saveLabel,
  onSave,
  onCancel,
  successMessage,
  wide,
  aside, // docked as a collapsible right sidebar (e.g. the AI assistant); receives `onClose`
  children,
}) {
  const { t } = usePreferences();
  const { setMeta } = usePageMeta();
  const [showSuccess, setShowSuccess] = useState(false);
  const [asideOpen, setAsideOpen] = useState(readAsideOpen);
  const dockRef = useRef(null);

  useEffect(() => {
    setMeta({ title, subtitle });
    return () => setMeta(null);
  }, [title, subtitle, setMeta]);

  useEffect(() => {
    try {
      localStorage.setItem(ASIDE_OPEN_KEY, asideOpen ? "1" : "0");
    } catch {
      /* ignore */
    }
    // A closed dock is only slid out of view; keep keyboard focus out of it too.
    if (dockRef.current) dockRef.current.inert = !asideOpen;
  }, [asideOpen]);

  // Ctrl/Cmd+J toggles the right sidebar (Ctrl+B already toggles the left one).
  useEffect(() => {
    if (!aside) return undefined;
    function onKeyDown(e) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setAsideOpen((open) => !open);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [aside]);

  async function handleSaveClick() {
    if (!onSave) return;
    const ok = await onSave();
    if (ok) setShowSuccess(true);
  }

  function handleSuccessClose() {
    setShowSuccess(false);
    onCancel?.();
  }

  const page = (
    <div className="detail-page">
      {/* Title is shown in the app header; this row keeps the breadcrumb and the save/cancel actions. */}
      <div className="detail-toolbar">
        <nav className="detail-breadcrumb" aria-label="Breadcrumb">
          {breadcrumbs.map((crumb, index) => (
            <React.Fragment key={`${crumb.label}-${index}`}>
              {index > 0 && <span className="detail-breadcrumb-sep">/</span>}
              {crumb.to ? (
                <Link to={crumb.to} className="detail-breadcrumb-link">
                  {crumb.label}
                </Link>
              ) : (
                <span className="detail-breadcrumb-current">{crumb.label}</span>
              )}
            </React.Fragment>
          ))}
        </nav>
        <div className="detail-actions">
          {aside && (
            <button
              type="button"
              className={`aside-toggle ${asideOpen ? "is-open" : ""}`}
              onClick={() => setAsideOpen((open) => !open)}
              aria-pressed={asideOpen}
              aria-controls="detail-aside-dock"
              title={`${t(asideOpen ? "assistant.close" : "assistant.open")} (Ctrl+J)`}
            >
              <IconSparkle size={14} />
              <span>{t("assistant.title")}</span>
            </button>
          )}
          <Button variant="secondary" onClick={onCancel} disabled={saving}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" onClick={handleSaveClick} disabled={saving}>
            {saveLabel || (saving ? "..." : t("common.save"))}
          </Button>
        </div>
      </div>

      {error && <ErrorBox className="detail-error">{error}</ErrorBox>}

      <div className={`detail-layout ${wide ? "detail-layout-wide" : ""}`}>{children}</div>

      {showSuccess && (
        <ConfirmModal
          variant="success"
          singleAction
          title={t("common.success")}
          message={successMessage || t("common.saveSuccess")}
          confirmLabel={t("common.ok")}
          onConfirm={handleSuccessClose}
          onClose={handleSuccessClose}
        />
      )}
    </div>
  );

  if (!aside) return page;

  // The dock stays mounted while closed so the chat keeps its history; it only slides out of view.
  return (
    <div className={`detail-shell ${asideOpen ? "aside-open" : ""}`}>
      {page}
      <aside id="detail-aside-dock" ref={dockRef} className="detail-dock" aria-hidden={!asideOpen}>
        <div className="detail-dock-inner">{React.cloneElement(aside, { onClose: () => setAsideOpen(false) })}</div>
      </aside>
    </div>
  );
}
