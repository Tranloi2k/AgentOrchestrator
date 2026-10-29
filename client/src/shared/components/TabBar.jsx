import React from "react";

/**
 * Tab bar — node panel tabs pattern.
 */
export default function TabBar({ tabs, active, onChange, className = "node-panel-tabs" }) {
  return (
    <div className={className}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={active === tab.id ? "active" : ""}
          onClick={() => onChange(tab.id)}
        >
          {tab.label}
          {tab.count > 0 && <span className="node-panel-tab-count">{tab.count}</span>}
        </button>
      ))}
    </div>
  );
}
