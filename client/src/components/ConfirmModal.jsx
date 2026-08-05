import React from "react";
import { IconCheck, IconClose, IconCopy, IconShieldAlert, IconTrash } from "../Icons.jsx";
import { usePreferences } from "../PreferencesContext.jsx";
import Button from "./Button.jsx";

/**
 * Confirmation, success notice, or blocked-action notice.
 * variant: "danger" (default) | "neutral" | "success"
 */
export default function ConfirmModal({
  title,
  message,
  blocked,
  reason,
  confirmLabel,
  danger = true,
  variant,
  singleAction = false,
  onConfirm,
  onClose,
}) {
  const { t } = usePreferences();
  const body = blocked ? reason : message;
  const tone = blocked
    ? "blocked"
    : variant || (danger ? "danger" : "neutral");
  const onlyConfirm = blocked || singleAction || tone === "success";

  const icon =
    tone === "blocked" ? (
      <IconShieldAlert size={22} />
    ) : tone === "success" ? (
      <IconCheck size={22} />
    ) : tone === "danger" ? (
      <IconTrash size={22} />
    ) : (
      <IconCopy size={22} />
    );

  return (
    <div className="modal-overlay confirm-modal-overlay" onClick={onClose}>
      <div
        className="modal-panel confirm-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className="confirm-modal-close"
          onClick={onClose}
          aria-label={t("common.close")}
        >
          <IconClose size={14} />
        </button>

        <div className="confirm-modal-content">
          <div className={`confirm-modal-icon-wrap ${tone}`} aria-hidden="true">
            {icon}
          </div>

          <h3 id="confirm-modal-title" className="confirm-modal-title">
            {title}
          </h3>
          <p className="confirm-modal-message">{body}</p>
        </div>

        <div className={`confirm-modal-footer ${onlyConfirm ? "single" : ""}`}>
          {!onlyConfirm && (
            <Button variant="secondary" onClick={onClose}>
              {t("common.cancel")}
            </Button>
          )}
          <Button
            variant="primary"
            color={tone === "danger" ? "danger" : "default"}
            onClick={onlyConfirm && blocked ? onClose : onConfirm}
          >
            {blocked
              ? t("common.close")
              : confirmLabel || (tone === "success" ? t("common.ok") : t("common.delete"))}
          </Button>
        </div>
      </div>
    </div>
  );
}
