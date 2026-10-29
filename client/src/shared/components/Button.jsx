import React from "react";

/**
 * Unified button — maps to existing design-system classes.
 * variant: primary (run-btn) | secondary | icon | headerIcon
 * color: default | danger
 */
export default function Button({
  variant = "primary",
  color = "default",
  className = "",
  type = "button",
  children,
  ...props
}) {
  const variantClass =
    variant === "primary"
      ? "run-btn"
      : variant === "secondary"
        ? "secondary-btn"
        : variant === "icon"
          ? "icon-btn"
          : variant === "headerIcon"
            ? "header-icon-btn"
            : "";

  const classes = [variantClass, color === "danger" ? "danger" : "", className].filter(Boolean).join(" ");

  return (
    <button type={type} className={classes} {...props}>
      {children}
    </button>
  );
}
