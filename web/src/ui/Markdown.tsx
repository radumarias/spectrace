import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** GitHub keeps PR templates' instructions in HTML comments; they are never meant to be read. */
export function stripHtmlComments(src: string): string {
  return src.replace(/<!--[\s\S]*?(?:-->|$)/g, "");
}

/**
 * Renders a GitHub-flavoured markdown body. Raw HTML in the source is dropped
 * (react-markdown never turns it into elements) and unsafe URL schemes are
 * rewritten by its default transform, so the output is safe to show.
 */
export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer noopener">{children}</a> }}
      >
        {stripHtmlComments(children).trim()}
      </ReactMarkdown>
    </div>
  );
}
