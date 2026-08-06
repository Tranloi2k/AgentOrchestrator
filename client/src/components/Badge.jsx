import React from "react";

const VARIANTS = ["pending", "running", "done", "error", "skipped", "cancelled"];

export default function Badge({ variant = "pending", uppercase = true, className = "", children, style, title }) {
  const variantClass = VARIANTS.includes(variant) ? variant : "pending";
  const classes = ["badge", variantClass, className].filter(Boolean).join(" ");

  return (
    <span
      className={classes}
      title={title}
      style={uppercase ? style : { textTransform: "none", letterSpacing: 0, ...style }}
    >
      {children}
    </span>
  );
}
