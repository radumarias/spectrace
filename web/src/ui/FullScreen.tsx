import { useEffect, useRef, useState, type ReactNode } from "react";

/** The diagram on its own screen, as in the prototype: Esc or Exit closes it, tall screens draw it top to bottom. */
export function FullScreen({
  title,
  onClose,
  foot,
  extra,
  children,
}: {
  title: string;
  onClose: () => void;
  foot?: ReactNode;
  /** Next to the zoom hint in the footer, such as a legend. */
  extra?: ReactNode;
  children: (vertical: boolean, zoomSlot: HTMLElement | null) => ReactNode;
}) {
  const [vertical, setVertical] = useState(() => window.innerHeight > window.innerWidth * 1.15);
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onResize = () => setVertical(window.innerHeight > window.innerWidth * 1.15);
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [onClose]);
  return (
    <div className="fs" role="dialog" aria-modal="true" aria-labelledby="fs-title">
      <div className="fs-bar">
        <button type="button" className="btn sm fs-x" onClick={onClose} aria-label="Exit full screen">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
          <span className="fs-xl">
            Exit <span className="mono sub">Esc</span>
          </span>
        </button>
        <h2 id="fs-title">{title}</h2>
        <div ref={setSlot} />
      </div>
      <div className="fs-body">{children(vertical, slot)}</div>
      <div className="fs-foot">
        <div className="fs-sum" aria-live="polite">{foot}</div>
        <div className="fs-extra">
          <span className="sub" style={{ fontSize: 12 }}>
            Scroll or pinch to zoom · drag to move
          </span>
          {extra}
        </div>
      </div>
    </div>
  );
}


/** The small "expand" button that floats on a diagram's corner. */
export function ExpandButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" className="dia-expand" aria-label={`Show ${label} full screen`} title="Full screen" onClick={onClick}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
      </svg>
    </button>
  );
}

/** Any already-drawn SVG (a sequence diagram, say) with the wheel and pinch to zoom and a drag to move, for full screen. */
export function PanZoom({ html, label }: { html: string; label: string }) {
  const [t, setT] = useState({ x: 0, y: 0, k: 1 });
  const drag = useRef<{ x: number; y: number; id: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const zoomAt = (factor: number, cx: number, cy: number) =>
    setT((v) => {
      const k = Math.min(8, Math.max(0.25, v.k * factor));
      const f = k / v.k;
      return { k, x: cx - (cx - v.x) * f, y: cy - (cy - v.y) * f };
    });
  const centre = () => {
    const r = box.current?.getBoundingClientRect();
    return { x: (r?.width ?? 0) / 2, y: (r?.height ?? 0) / 2 };
  };
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  return (
    <div className="pz-wrap">
      <div
        ref={box}
        className="pz"
        role="img"
        aria-label={label}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // Synthetic events have no active pointer.
          }
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d || d.id !== e.pointerId) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          d.x = e.clientX;
          d.y = e.clientY;
          setT((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
        }}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
      >
        {/* pele's output: a generated SVG with the labels escaped. */}
        <div className="pz-in" style={{ transform: `translate(${t.x}px,${t.y}px) scale(${t.k})` }} dangerouslySetInnerHTML={{ __html: html }} />
      </div>
      <div className="zoom pz-zoom" role="group" aria-label="Zoom diagram">
        <button type="button" aria-label="Zoom out" onClick={() => zoomAt(1 / 1.25, centre().x, centre().y)}>
          −
        </button>
        <span aria-live="polite">{Math.round(t.k * 100)}%</span>
        <button type="button" aria-label="Zoom in" onClick={() => zoomAt(1.25, centre().x, centre().y)}>
          +
        </button>
        <button type="button" aria-label="Fit diagram" style={{ fontSize: 11 }} onClick={() => setT({ x: 0, y: 0, k: 1 })}>
          Fit
        </button>
      </div>
    </div>
  );
}
