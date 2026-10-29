import React from "react";
import { IconClose } from "../Icons.jsx";

/**
 * Base modal shell — overlay + panel. Used by ConfirmModal, DirBrowserModal, etc.
 */
export default function Modal({
  onClose,
  title,
  children,
  footer,
  className = "",
  panelClassName = "",
  closeLabel = "Close",
  showClose = true,
}) {
  return (
    <div className={`modal-overlay ${className}`.trim()} onClick={onClose}>
      <div
        className={`modal-panel ${panelClassName}`.trim()}
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        {(title || showClose) && (
          <div className="modal-header">
            {title ? <span>{title}</span> : <span />}
            {showClose && (
              <button type="button" className="icon-btn" onClick={onClose} aria-label={closeLabel}>
                <IconClose size={14} />
              </button>
            )}
          </div>
        )}
        {children}
        {footer}
      </div>
    </div>
  );
}
