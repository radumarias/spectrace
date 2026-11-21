// A spec's Mermaid diagram, drawn by pele the way devpage draws it, with the
// prototype's interaction on top: every node is a button, `click … href` lines
// are the node's action (mermaid-actions: `spec://<step>` and `action:step`
// select that step; `action:copy`, `toggle` and `show` work as in
// xoriors/experimental's viewer; http links open), node colours
// follow the step's status, and the drawing zooms and pans inside its own box
// (never the page) by changing its viewBox.
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { decorate, mount, parseClicks } from "./actions";
import { useToast } from "../ui/Toast";
import type { StepStatus } from "./model";

type Pele = typeof import("./pele");
let loading: Promise<Pele> | null = null;
const loadPele = () => (loading ??= import("./pele"));

export type ViewBox = [number, number, number, number];

export interface DiagramProps {
  /** Mermaid flowchart text. */
  source: string;
  label: string;
  /** Node id to status, for colouring. Nodes not listed keep pele's colours. */
  status?: Record<string, StepStatus>;
  selected?: string | null;
  /** Called with the node id when a node is clicked or activated by keyboard. */
  onSelect?: (node: string) => void;
  /** Full screen: the drawing fills its box and the wheel zooms. */
  fill?: boolean;
  /** Draw top to bottom (a tall screen), whatever direction the source says. */
  vertical?: boolean;
  /** Where the zoom controls go; given the controls, returns what to render next to the drawing. */
  tools?: (zoom: ReactNode) => ReactNode;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5;

/** `flowchart LR` becomes `flowchart TD`. */
function verticalOf(source: string): string {
  return source.replace(/^(\s*(?:flowchart|graph))\s+(LR|RL|TD|TB|BT)\b/m, "$1 TD");
}

/** Click targets of the `spec://` scheme name a step; the node id is its last segment. */
function nodeOfHref(href: string): string | null {
  const m = /^spec:\/\/[a-z][a-z0-9_]*\.([a-z][a-z0-9_]*)$/.exec(href);
  return m ? m[1]! : null;
}

export function Diagram({ source, label, status, selected, onSelect, fill, vertical, tools }: DiagramProps) {
  const prefix = `d${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const box = useRef<HTMLDivElement>(null);
  const [drawn, setDrawn] = useState<{ svg: string; width: number; height: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vb, setVb] = useState<ViewBox | null>(null);
  const text = vertical ? verticalOf(source) : source;

  useEffect(() => {
    let live = true;
    loadPele()
      .then((p) => {
        if (!live) return;
        try {
          const d = p.draw(text, prefix);
          setDrawn(d);
          setError(null);
          setVb([0, 0, d.width, d.height]);
        } catch (e) {
          setDrawn(null);
          setError(e instanceof Error ? e.message : String(e));
        }
      })
      .catch((e: unknown) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [text, prefix]);

  const svgEl = () => box.current?.querySelector("svg") ?? null;

  // Nodes as buttons, coloured by status, the selected one outlined.
  useLayoutEffect(() => {
    const svg = svgEl();
    if (!svg || !drawn) return;
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    // pele writes `max-width:100%;height:auto` inline; full screen needs the drawing to fill its box instead.
    svg.style.maxWidth = fill ? "none" : `${Math.round(drawn.width * 1.4)}px`;
    svg.style.width = "100%";
    svg.style.height = fill ? "100%" : "auto";
    svg.setAttribute("aria-label", label);
    decorate(svg, parseClicks(text));
    svg.querySelectorAll<SVGGElement>(".pele-node[data-id]").forEach((g) => {
      const id = g.dataset.id!;
      const st = status?.[id];
      if (st) g.dataset.st = st;
      else delete g.dataset.st;
      g.classList.toggle("sel", id === selected);
      const link = g.querySelector("a");
      const target = link ?? g;
      if (link) link.setAttribute("aria-current", id === selected ? "true" : "false");
      else {
        g.setAttribute("tabindex", "0");
        g.setAttribute("role", "button");
      }
      const text = g.textContent?.trim() ?? id;
      target.setAttribute("aria-label", text);
    });
  }, [drawn, status, selected, fill, label, text]);

  useLayoutEffect(() => {
    const svg = svgEl();
    if (svg && vb) svg.setAttribute("viewBox", vb.join(" "));
  }, [vb, drawn]);

  const zoomBy = useCallback(
    (factor: number, at?: { x: number; y: number }) => {
      if (!drawn) return;
      setVb((v) => {
        if (!v) return v;
        const nw = Math.min(drawn.width / MIN_ZOOM, Math.max(drawn.width / MAX_ZOOM, v[2] / factor));
        const k = nw / v[2];
        const p = at ?? { x: v[0] + v[2] / 2, y: v[1] + v[3] / 2 };
        return [p.x - (p.x - v[0]) * k, p.y - (p.y - v[1]) * k, nw, v[3] * k];
      });
    },
    [drawn],
  );
  const fit = useCallback(() => drawn && setVb([0, 0, drawn.width, drawn.height]), [drawn]);

  /** Screen point to drawing coordinates. */
  const toSvg = (clientX: number, clientY: number) => {
    const svg = svgEl();
    const m = svg?.getScreenCTM();
    if (!svg || !m) return undefined;
    const pt = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return { x: pt.x, y: pt.y };
  };

  // Drag to pan; a press that did not move is a click on a node.
  const drag = useRef<{ x: number; y: number; moved: boolean; id: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, moved: false, id: e.pointerId };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const svg = svgEl();
    if (!d || d.id !== e.pointerId || !svg || !vb) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 5) return;
    if (!d.moved) {
      d.moved = true;
      try {
        (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      } catch {
        // Synthetic events in tests have no active pointer.
      }
    }
    const r = svg.getBoundingClientRect();
    const scale = Math.max(vb[2] / (r.width || 1), vb[3] / (r.height || 1));
    d.x = e.clientX;
    d.y = e.clientY;
    setVb([vb[0] - dx * scale, vb[1] - dy * scale, vb[2], vb[3]]);
  };
  const onPointerUp = () => {
    // Keep `moved` until the click that follows has been seen.
    setTimeout(() => (drag.current = null), 0);
  };

  // Actions first (mermaid-actions), in the capture phase so a drag that panned is not taken for a click.
  const select = useRef(onSelect);
  select.current = onSelect;
  const toast = useToast();
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const afterDrag = (e: MouseEvent) => {
      if (!drag.current?.moved) return;
      e.preventDefault();
      e.stopPropagation();
    };
    el.addEventListener("click", afterDrag, true);
    const actions = mount(el, {
      toast,
      select: (node) => select.current?.(node),
      onLink: (href, _a, e) => {
        const node = nodeOfHref(href);
        if (node) {
          e.preventDefault();
          select.current?.(node);
        } else if (href.startsWith("#")) {
          e.preventDefault();
          document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ behavior: "smooth", block: "start" });
        } else if (/^https?:/.test(href)) {
          e.preventDefault();
          window.open(href, "_blank", "noopener,noreferrer");
        }
      },
    });
    return () => {
      el.removeEventListener("click", afterDrag, true);
      actions.destroy();
    };
  }, [toast]);

  // A node with no link is still a button: clicking it selects the step.
  const onClick = (e: React.MouseEvent) => {
    if (e.defaultPrevented) return;
    const el = e.target instanceof Element ? e.target : null;
    if (el?.closest("a")) return;
    const node = el?.closest<SVGGElement>(".pele-node[data-id]")?.dataset.id;
    if (node) onSelect?.(node);
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const el = e.target instanceof Element ? e.target : null;
    const g = el?.closest<SVGGElement>(".pele-node[data-id]");
    // A linked node is an <a>: the browser turns Enter into a click on it.
    if (!g || g.querySelector("a")) return;
    e.preventDefault();
    onSelect?.(g.dataset.id!);
  };

  // The wheel zooms in full screen, or anywhere with Ctrl/Cmd held (a pinch on a trackpad); otherwise the page scrolls.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!fill && !e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15, toSvg(e.clientX, e.clientY));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // toSvg only reads the DOM.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fill, zoomBy]);

  const pct = drawn && vb ? Math.round((100 * drawn.width) / vb[2]) : 100;
  const zoom = (
    <div className="zoom" role="group" aria-label="Zoom diagram">
      <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / 1.25)} disabled={!drawn}>
        −
      </button>
      <span aria-live="polite">{pct}%</span>
      <button type="button" aria-label="Zoom in" onClick={() => zoomBy(1.25)} disabled={!drawn}>
        +
      </button>
      <button type="button" aria-label="Fit diagram" style={{ fontSize: 11 }} onClick={fit} disabled={!drawn}>
        Fit
      </button>
    </div>
  );

  if (error) {
    return (
      <div className="dia-error" role="alert">
        <b>Diagram error:</b> {error}
        <pre className="code">{source}</pre>
      </div>
    );
  }
  return (
    <>
      <div
        ref={box}
        className={`spec-dia${fill ? " fill" : ""}`}
        role="group"
        aria-label={label}
        aria-busy={!drawn}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={onClick}
        onKeyDown={onKeyDown}
        // pele's output: generated SVG with the labels escaped and only spec: links kept, as devpage serves it.
        dangerouslySetInnerHTML={drawn ? { __html: drawn.svg } : undefined}
      >
        {drawn ? undefined : null}
      </div>
      {tools?.(zoom)}
    </>
  );
}
