import React, { useEffect, useRef, useState } from "react";
import { IconWorkflow, IconPlus, IconClose, ProviderIcon } from "./Icons.jsx";
import { usePreferences } from "./PreferencesContext.jsx";

const NODE_W = 180;
const NODE_H = 80;
const GAP_X = 110;
const GAP_Y = 20;
const PAD = 60;
const DRAG_THRESHOLD = 4; // px of movement before a mousedown-on-node counts as a drag, not a click

/** Layer each node = longest path length from any root (node with no incoming edge).
 * Nodes sharing a layer are stacked vertically (parallel branches). Defensive against
 * cycles via an iteration cap (the UI never lets the user create one, but a raw API
 * call could). Only used as the initial placement for nodes that don't have an explicit
 * (x, y) yet — once a node is dragged, its stored position wins from then on. */
function layoutGraph(nodes, edges) {
  const layer = new Map(nodes.map((n) => [n.id, 0]));

  // Hard ceiling on layer number itself (not just pass count) — a cycle can still make a
  // few passes each add +1..+N to a layer before the pass cap below kicks in, which without
  // this would blow the canvas out to thousands of px wide.
  const layerCeiling = Math.max(1, nodes.length - 1);
  let cap = nodes.length * nodes.length + 10;
  let changed = true;
  while (changed && cap-- > 0) {
    changed = false;
    for (const e of edges) {
      const next = Math.min(layerCeiling, (layer.get(e.from) ?? 0) + 1);
      if ((layer.get(e.to) ?? 0) < next) {
        layer.set(e.to, next);
        changed = true;
      }
    }
  }

  const byLayer = new Map();
  for (const n of nodes) {
    const l = layer.get(n.id) ?? 0;
    if (!byLayer.has(l)) byLayer.set(l, []);
    byLayer.get(l).push(n.id);
  }

  const pos = new Map();
  for (const [l, ids] of byLayer) {
    ids.forEach((id, i) => {
      pos.set(id, { x: PAD + l * (NODE_W + GAP_X), y: PAD + i * (NODE_H + GAP_Y) });
    });
  }
  return pos;
}

/**
 * n8n-style node graph: nodes at freely draggable positions (auto-placed on first
 * appearance, then whatever the user drags them to), connected by bezier edges
 * (optionally labelled with a router `condition`), with pan (drag background) and zoom
 * (wheel / buttons). Auto-fits all nodes into view on mount / whenever the node/edge count changes.
 *
 * nodes: [{ id, title, subtitle, status?, kind?, provider?, x?, y? }]
 *   x/y (optional): explicit canvas position in graph units; omit to auto-place via layering.
 * edges: [{ id, from, to, condition?, status? }]  — regular data-flow edges (solid line)
 * callEdges: [{ from, to, status? }]  — "may call & wait" relationships from calleeNodeIds
 *   (dashed line with a ↔ marker); purely visual, never affects layout/position.
 * onNodeMove?(id, x, y) — called while dragging a node (editable mode only); persist it
 *   onto that node's x/y so the layout survives reload.
 */
export default function WorkflowCanvas({
  nodes,
  edges,
  callEdges = [],
  selectedId,
  onNodeClick,
  onAddNode,
  onRemoveNode,
  onAddRoot,
  onNodeMove,
  readOnly = false,
}) {
  const { t } = usePreferences();
  const [view, setView] = useState({ x: 24, y: 24, scale: 1 });
  const panRef = useRef(null);
  const nodeDragRef = useRef(null);
  const wrapRef = useRef(null);

  // Layout is driven by regular edges only. callEdges are frequently reciprocal (A calls B
  // *and* B calls A) — feeding those into the layering pass would form a cycle and blow up
  // layer numbers unboundedly, so they're drawn as an overlay instead of affecting position.
  const autoPos = layoutGraph(nodes, edges);
  const pos = new Map();
  for (const n of nodes) {
    pos.set(n.id, typeof n.x === "number" && typeof n.y === "number" ? { x: n.x, y: n.y } : autoPos.get(n.id) || { x: 0, y: 0 });
  }
  const xs = [...pos.values()].map((p) => p.x);
  const ys = [...pos.values()].map((p) => p.y);
  const totalWidth = (xs.length ? Math.max(...xs) : 0) + NODE_W + PAD;
  const totalHeight = (ys.length ? Math.max(...ys) : 0) + NODE_H + PAD;

  function center(id) {
    const p = pos.get(id);
    return p ? { x: p.x + NODE_W, y: p.y + NODE_H / 2 } : { x: 0, y: 0 };
  }
  function left(id) {
    const p = pos.get(id);
    return p ? { x: p.x, y: p.y + NODE_H / 2 } : { x: 0, y: 0 };
  }
  function edgePath(e, bow = 0) {
    const a = center(e.from);
    const b = left(e.to);
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2 + bow;
    return {
      d: `M ${a.x} ${a.y} C ${midX} ${a.y + bow}, ${midX} ${b.y + bow}, ${b.x} ${b.y}`,
      mid: { x: midX, y: midY },
    };
  }

  // A calls B *and* B calls A -> draw as one line with an arrowhead at both ends instead of
  // two separate overlapping/bowed lines.
  const mergedCallEdges = [];
  {
    const seenPairs = new Map();
    for (const e of callEdges) {
      const key = [e.from, e.to].sort().join("|");
      if (!seenPairs.has(key)) seenPairs.set(key, []);
      seenPairs.get(key).push(e);
    }
    for (const list of seenPairs.values()) {
      if (list.length >= 2) {
        const [a, b] = list;
        mergedCallEdges.push({ from: a.from, to: a.to, bidirectional: true, status: a.status || b.status });
      } else {
        mergedCallEdges.push(list[0]);
      }
    }
  }

  function onWheel(e) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.08 : 0.08;
    setView((v) => ({ ...v, scale: Math.min(1.6, Math.max(0.4, +(v.scale + delta).toFixed(2))) }));
  }

  function onCanvasMouseDown(e) {
    if (e.target !== wrapRef.current && !e.target.classList.contains("canvas-bg")) return;
    panRef.current = { startX: e.clientX, startY: e.clientY, origX: view.x, origY: view.y };
  }

  function onNodeMouseDown(e, n) {
    if (readOnly) return;
    e.stopPropagation();
    const p = pos.get(n.id);
    nodeDragRef.current = {
      id: n.id,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startX: p.x,
      startY: p.y,
      moved: false,
    };
  }

  function onMouseMove(e) {
    if (nodeDragRef.current) {
      const d = nodeDragRef.current;
      const dx = (e.clientX - d.startClientX) / view.scale;
      const dy = (e.clientY - d.startClientY) / view.scale;
      if (!d.moved && Math.hypot(e.clientX - d.startClientX, e.clientY - d.startClientY) > DRAG_THRESHOLD) {
        d.moved = true;
      }
      if (d.moved) onNodeMove?.(d.id, Math.round(d.startX + dx), Math.round(d.startY + dy));
      return;
    }
    if (!panRef.current) return;
    const { startX, startY, origX, origY } = panRef.current;
    setView((v) => ({ ...v, x: origX + (e.clientX - startX), y: origY + (e.clientY - startY) }));
  }

  function onMouseUp(e, n) {
    if (nodeDragRef.current) {
      const wasClick = !nodeDragRef.current.moved;
      const id = nodeDragRef.current.id;
      nodeDragRef.current = null;
      if (wasClick) onNodeClick?.(n?.id ?? id);
      return;
    }
    panRef.current = null;
  }

  function zoomBy(delta) {
    setView((v) => ({ ...v, scale: Math.min(1.6, Math.max(0.4, +(v.scale + delta).toFixed(2))) }));
  }

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const availW = el.clientWidth;
    const availH = el.clientHeight;
    if (!availW || !availH) return;
    const scale = Math.max(0.4, Math.min(1, availW / totalWidth, availH / totalHeight, 1.6));
    const s = +scale.toFixed(2);
    setView({
      x: Math.max(12, (availW - totalWidth * s) / 2),
      y: Math.max(12, (availH - totalHeight * s) / 2),
      scale: s,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length, edges.length, callEdges.length, readOnly]);

  if (!nodes.length) {
    return (
      <div className="workflow-canvas empty">
        {!readOnly && onAddRoot && (
          <button type="button" className="canvas-add-root" onClick={onAddRoot}>
            <IconPlus size={16} /> {t("workflows.canvas.addFirst")}
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      ref={wrapRef}
      className={`workflow-canvas ${readOnly ? "readonly" : ""}`}
      onWheel={onWheel}
      onMouseDown={onCanvasMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={() => onMouseUp()}
      onMouseLeave={() => onMouseUp()}
    >
      <div className="canvas-bg" style={{ width: "100%", height: "100%", position: "absolute", inset: 0 }} />
      <div
        className="canvas-content"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, width: totalWidth, height: totalHeight }}
      >
        <svg className="canvas-edges" width={totalWidth} height={totalHeight}>
          {edges.map((e) => {
            const { d, mid } = edgePath(e);
            const cls = e.status === "done" ? "active" : e.status === "running" ? "flowing" : e.status === "skipped" ? "skipped" : "";
            return (
              <g key={e.id ?? `${e.from}-${e.to}`}>
                <path d={d} className={`canvas-edge ${cls}`} />
                {e.condition && (
                  <text x={mid.x} y={mid.y - 6} textAnchor="middle" className="canvas-edge-label">
                    {e.condition}
                  </text>
                )}
              </g>
            );
          })}
          {mergedCallEdges.map((e, i) => {
            // Single (one-way) calls keep a slight bow so they read as distinct from a
            // regular edge even when running parallel to one; reciprocal ones are drawn
            // as one straight line with an arrowhead at both ends.
            const bow = e.bidirectional ? 0 : e.from < e.to ? 16 : -16;
            const { d } = edgePath(e, bow);
            const cls = e.status === "done" ? "active" : e.status === "running" ? "flowing" : "";
            return (
              <path
                key={`call-${e.from}-${e.to}-${i}`}
                d={d}
                className={`canvas-edge call ${cls}`}
                markerEnd="url(#call-arrow)"
                markerStart={e.bidirectional ? "url(#call-arrow)" : undefined}
              />
            );
          })}
          <defs>
            <marker id="call-arrow" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0 0 L8 4 L0 8 z" className="canvas-edge-arrowhead" />
            </marker>
          </defs>
        </svg>

        {nodes.map((n) => {
          const p = pos.get(n.id) || { x: 0, y: 0 };
          return (
            <div
              key={n.id}
              className={`canvas-node status-${n.status || "pending"} ${selectedId === n.id ? "selected" : ""} ${
                n.kind === "router" ? "router" : ""
              } ${readOnly ? "readonly" : "draggable"}`}
              style={{ left: p.x, top: p.y, width: NODE_W, height: NODE_H }}
              onMouseDown={(e) => onNodeMouseDown(e, n)}
              onMouseUp={(e) => onMouseUp(e, n)}
              onClick={() => readOnly && onNodeClick?.(n.id)}
            >
              <span className={`canvas-node-icon ${n.kind === "router" ? "router" : "provider"}`}>
                {n.kind === "router" ? (
                  <IconWorkflow size={14} />
                ) : (
                  <ProviderIcon provider={n.provider || "claude"} size={18} />
                )}
              </span>
              <div className="canvas-node-text">
                <div className="canvas-node-title">{n.title}</div>
                {n.subtitle && <div className="canvas-node-subtitle">{n.subtitle}</div>}
                {/* This is the id `ask_agent` needs — separate from the agent's own id on the
                    Agents tab — so it has to be visible right here, not buried in a tab. */}
                <div className="canvas-node-id" title={`id="${n.id}"`}>
                  id=&quot;{n.id}&quot;
                </div>
              </div>
              <span className={`canvas-node-dot status-${n.status || "pending"}`} />
              {!readOnly && (
                <>
                  <button
                    type="button"
                    className="canvas-node-add"
                    title={t("workflows.canvas.addNext")}
                    onClick={(e) => {
                      e.stopPropagation();
                      onAddNode?.(n.id);
                    }}
                  >
                    <IconPlus size={12} />
                  </button>
                  <button
                    type="button"
                    className="canvas-node-remove"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemoveNode?.(n.id);
                    }}
                  >
                    <IconClose size={12} />
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      {(edges.length > 0 || callEdges.length > 0) && (
        <div className="canvas-legend">
          {edges.length > 0 && (
            <div className="canvas-legend-item">
              <svg width="22" height="10" className="canvas-legend-swatch">
                <path d="M1 5 H21" className="canvas-edge" />
              </svg>
              {t("workflows.canvas.legendData")}
            </div>
          )}
          {callEdges.length > 0 && (
            <div className="canvas-legend-item">
              <svg width="22" height="10" className="canvas-legend-swatch">
                <path d="M1 5 H21" className="canvas-edge call" />
              </svg>
              {t("workflows.canvas.legendCall")}
            </div>
          )}
        </div>
      )}

      <div className="canvas-controls">
        <button type="button" onClick={() => zoomBy(-0.1)} title={t("workflows.canvas.zoomOut")}>
          −
        </button>
        <button type="button" onClick={() => setView((v) => ({ ...v }))} title={t("workflows.canvas.zoom")}>
          {Math.round(view.scale * 100)}%
        </button>
        <button type="button" onClick={() => zoomBy(0.1)} title={t("workflows.canvas.zoomIn")}>
          +
        </button>
      </div>
    </div>
  );
}
