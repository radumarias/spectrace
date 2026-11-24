import { Fragment, type ReactNode } from "react";

/**
 * One line of text with the inline marks people expect from Slack and GitHub: `code` and **bold**.
 * Nothing else is interpreted, and no HTML is ever produced from the text.
 */
export function Inline({ children }: { children: string }) {
  const out: ReactNode[] = [];
  // Code first, so ** inside backticks stays literal.
  const parts = children.split(/(`[^`\n]+`)/g);
  parts.forEach((part, i) => {
    if (part.length > 2 && part.startsWith("`") && part.endsWith("`")) {
      out.push(<code key={i} className="ic">{part.slice(1, -1)}</code>);
      return;
    }
    part.split(/(\*\*[^*\n]+\*\*)/g).forEach((bit, j) => {
      if (bit.length > 4 && bit.startsWith("**") && bit.endsWith("**")) out.push(<b key={`${i}-${j}`}>{bit.slice(2, -2)}</b>);
      else if (bit) out.push(<Fragment key={`${i}-${j}`}>{bit}</Fragment>);
    });
  });
  return <>{out}</>;
}
