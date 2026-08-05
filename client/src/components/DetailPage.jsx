import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { usePreferences } from "../PreferencesContext.jsx";
import { usePageMeta } from "../PageMetaContext.jsx";
import Button from "./Button.jsx";
import ConfirmModal from "./ConfirmModal.jsx";
import { ErrorBox } from "./Feedback.jsx";

export { DetailSection, DetailField, DetailFieldGrid } from "./DetailLayout.jsx";

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
  children,
}) {
  const { t } = usePreferences();
  const { setMeta } = usePageMeta();
  const [showSuccess, setShowSuccess] = useState(false);

  useEffect(() => {
    setMeta({ title, subtitle });
    return () => setMeta(null);
  }, [title, subtitle, setMeta]);

  async function handleSaveClick() {
    if (!onSave) return;
    const ok = await onSave();
    if (ok) setShowSuccess(true);
  }

  function handleSuccessClose() {
    setShowSuccess(false);
    onCancel?.();
  }

  return (
    <div className="detail-page">
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

      <div className="detail-toolbar">
        <div className="detail-title-block">
          <h2 className="detail-heading">{title}</h2>
          {subtitle && <p className="detail-subheading">{subtitle}</p>}
        </div>
        <div className="detail-actions">
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
}
