// Any Mermaid diagram pele draws (the renderer devpage uses), with its
// diagram type loaded on demand. Used by the whiteboard and requirements views.
import { useEffect, useId, useState } from "react";

/** Any Mermaid diagram pele draws, loaded with its diagram type on demand. */
export function MermaidPreview({ text, label }: { text: string; label: string }) {
  const prefix = useId().replace(/[^a-zA-Z0-9]/g, "");
  const [out, setOut] = useState<{ svg: string } | { error: string } | null>(null);
  useEffect(() => {
    let live = true;
    import("pele/lazy")
      .then((m) => m.renderAsync(text, { idPrefix: `wb${prefix}`, linkSchemes: ["http", "https", "mailto"] }))
      .then(
        (r) => live && setOut({ svg: r.svg }),
        (e: unknown) => live && setOut({ error: e instanceof Error ? e.message : String(e) }),
      );
    return () => {
      live = false;
    };
  }, [text, prefix]);
  if (!out) return <p className="sub">Drawing…</p>;
  if ("error" in out) return <p className="dia-error" role="alert">{out.error}</p>;
  // pele builds the SVG from the board's own text and escapes labels.
  return <div className="board-svg" role="img" aria-label={label} dangerouslySetInnerHTML={{ __html: out.svg }} />;
}

