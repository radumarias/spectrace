import { useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

/** GitHub keeps PR templates' instructions in HTML comments; they are never meant to be read. */
export function stripHtmlComments(src: string): string {
  return src.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
}

/**
 * GitHub's own allow-list (hast-util-sanitize's defaultSchema is derived from it):
 * details/summary, links, headings, blockquotes, code, tables, images, but no
 * script, style, iframe, forms or event handlers. `open` is allowed so a
 * <details open> stays open.
 */
const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    details: ["open"],
  },
  tagNames: [...(defaultSchema.tagNames ?? []), "details", "summary"],
};

/** Bodies longer than this are folded behind "Show more", like long release notes on GitHub. */
const FOLD_AT = 1200;

/**
 * Renders a GitHub-flavoured markdown body, including GitHub's HTML subset
 * (parsed by rehype-raw, then always passed through rehype-sanitize, so
 * the output is safe to show).
 */
export function Markdown({ children, fold = false }: { children: string; fold?: boolean }) {
  const [more, setMore] = useState(false);
  const src = stripHtmlComments(children).trim();
  const folded = fold && !more && src.length > FOLD_AT;
  return (
    <div>
      <div className={folded ? "md md-folded" : "md"}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRaw, [rehypeSanitize, schema]]}
          components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> }}
        >
          {src}
        </ReactMarkdown>
      </div>
      {fold && src.length > FOLD_AT && (
        <button type="button" className="btn" style={{ marginTop: 8 }} onClick={() => setMore(!more)}>
          {more ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}
