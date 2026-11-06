import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

const EDGE_GAP = 8;
const ENABLED_ITEM = '[role="menuitem"]:not([aria-disabled])';

/**
 * Right-click menu opened at the pointer (x, y in viewport coordinates). Nudged back inside the
 * window when it would overflow; closes on an outside click, Esc, scroll, resize or window blur.
 * items: [{ label, icon?, danger?, disabled?, title?, onSelect }]
 */
export default function ContextMenu({ x, y, items, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ left: x, top: y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({
      left: Math.max(EDGE_GAP, Math.min(x, window.innerWidth - width - EDGE_GAP)),
      top: Math.max(EDGE_GAP, Math.min(y, window.innerHeight - height - EDGE_GAP)),
    });
    el.querySelector(ENABLED_ITEM)?.focus();
  }, [x, y]);

  useEffect(() => {
    const onPointerDown = (e) => {
      if (!ref.current?.contains(e.target)) onClose();
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("scroll", onClose, true);
    window.addEventListener("resize", onClose);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onClose, true);
      window.removeEventListener("resize", onClose);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  function moveFocus(e) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const enabled = [...ref.current.querySelectorAll(ENABLED_ITEM)];
    if (!enabled.length) return;
    const i = enabled.indexOf(document.activeElement);
    const next = e.key === "ArrowDown" ? (i + 1) % enabled.length : (i - 1 + enabled.length) % enabled.length;
    enabled[next].focus();
  }

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      style={pos}
      onKeyDown={moveFocus}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={`context-menu-item ${item.danger ? "is-danger" : ""}`.trim()}
          // aria-disabled (not disabled) so the tooltip explaining why still shows on hover.
          aria-disabled={item.disabled || undefined}
          title={item.title}
          onClick={() => {
            if (item.disabled) return;
            onClose();
            item.onSelect();
          }}
        >
          {item.icon && <span className="context-menu-icon">{item.icon}</span>}
          {item.label}
        </button>
      ))}
    </div>
  );
}
