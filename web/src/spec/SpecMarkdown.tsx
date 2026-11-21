// The spec file rendered as a page, the way devpage renders Markdown: the
// mermaid fence becomes the diagram (with its actions), `{#id}` on a heading
// becomes the heading's anchor, requirement lines get their WHEN / THE SYSTEM
// SHALL keywords and test status, and a `> @flow` quote shows as the step's
// reason. Clicking a step heading selects that step.
import type { ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Pill } from "../ui/parts";
import { Diagram } from "./Diagram";
import type { Step, StepStatus } from "./model";

type Pos = { position?: { start: { line: number }; end: { line: number } } };

const HEADING_ID = /\s*\{#([a-z][a-z0-9_.]*)\}\s*$/;

/** Plain text of React children, for matching. */
function textOf(children: ReactNode): string {
  if (children == null || typeof children === "boolean") return "";
  if (typeof children === "string" || typeof children === "number") return String(children);
  if (Array.isArray(children)) return children.map(textOf).join("");
  if (typeof children === "object" && "props" in children) return textOf((children.props as { children?: ReactNode }).children);
  return "";
}

/** Drops the trailing ` {#id}` from a heading's last text child. */
function stripId(children: ReactNode): ReactNode {
  const list = Array.isArray(children) ? [...children] : [children];
  const last = list.length - 1;
  if (typeof list[last] === "string") list[last] = (list[last] as string).replace(HEADING_ID, "");
  return list;
}

export function SpecMarkdown({
  source,
  steps,
  selected,
  onSelect,
  status,
}: {
  source: string;
  steps: Step[];
  selected: string | null;
  onSelect: (node: string) => void;
  status: Record<string, StepStatus>;
}) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  /** The step whose section holds a source line: the last heading at or above it. */
  const stepAt = (line: number) => {
    let found: Step | undefined;
    for (const s of steps) if (s.line <= line && (!found || s.line > found.line)) found = s;
    return found;
  };
  const reqAt = (line: number) => {
    for (const s of steps) {
      const r = s.reqs.find((q) => q.line <= line && line <= q.endLine);
      if (r) return { step: s, req: r };
    }
    return null;
  };

  const heading = (Tag: "h1" | "h2" | "h3") =>
    function H({ children }: { children?: ReactNode }) {
      const id = HEADING_ID.exec(textOf(children))?.[1];
      const step = id ? byId.get(id) : undefined;
      const body = (
        <>
          {stripId(children)} {id && <span className="mono sub" style={{ fontSize: 11 }}>#{id}</span>}
        </>
      );
      if (!step) return <Tag id={id}>{body}</Tag>;
      return (
        <Tag id={id} className={`md-step${step.node === selected ? " on" : ""}`}>
          <button type="button" onClick={() => onSelect(step.node)} aria-pressed={step.node === selected}>
            {body}
          </button>
        </Tag>
      );
    };

  const components: Components = {
    h1: heading("h1"),
    h2: heading("h2"),
    h3: heading("h3"),
    a: ({ href, children }) =>
      href?.startsWith("#") ? <a href={href}>{children}</a> : <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>,
    pre: ({ children }) => <>{children}</>,
    code: ({ className, children }) => {
      if (className === "language-mermaid") {
        return (
          <div className="md-dia">
            <Diagram source={textOf(children)} label="Diagram" status={status} selected={selected} onSelect={onSelect} />
          </div>
        );
      }
      if (className) return <pre className="code">{children}</pre>;
      return <code>{children}</code>;
    },
    li: ({ node, children }) => {
      const at = reqAt((node as Pos | undefined)?.position?.start.line ?? -1);
      if (!at) return <li>{children}</li>;
      const { req } = at;
      return (
        <li className="md-req">
          <span className="ears">WHEN</span> {req.condition} <span className="ears">THE SYSTEM SHALL</span> {req.response}.{" "}
          <span className="mono sub" style={{ fontSize: 11 }}>#{req.tag}</span> <Pill tone={req.tested ? "ok" : "idle"}>{req.tested ? "tested" : "no test"}</Pill>
        </li>
      );
    },
    blockquote: ({ node, children }) => {
      const text = textOf(children).trim();
      if (!text.startsWith("@flow")) return <blockquote>{children}</blockquote>;
      const step = stepAt((node as Pos | undefined)?.position?.start.line ?? -1);
      return (
        <div className="md-flow">
          <span className="mono">flow{step ? ` · ${step.id}` : ""}</span>
          {text.replace(/^@flow\s*/, "")}
        </div>
      );
    },
  };

  return (
    <div className="md spec-md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
