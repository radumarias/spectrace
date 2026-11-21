// mermaid-actions: clickable actions declared as `click node href "action:name?key=value"`
// lines in a Mermaid block. Ported to TypeScript from
// https://github.com/xoriors/experimental/tree/main/mermaid-actions (Apache-2.0,
// mermaid-actions.js), which runs them on diagrams drawn by pele 1.10.0, as here.
//
//   register(name, fn)   add or replace an action; fn(params, node, ctx)
//   mount(root, opts)    one click handler on `root`; returns { destroy }
//   run(href, node, ctx) run one `action:` href
//   parseClicks(source)  { nodeId: { href, tooltip } } of the `action:` click lines
//   nodeIdOf(target)     { id, el } of the diagram node under a DOM element, or null
//   decorate(root, clicks, cls)  add `cls` to the nodes that have an action
//
// spectrace adds one action, `step`, and the context it needs: `ctx.select(node)`
// selects a step of the spec on screen. `spec://<flow>.<node>` links (the spec
// format's own click target) reach the host through `onLink`.

export interface ActionContext {
  root: Element | Document;
  doc: Document;
  toast: (msg: string) => void;
  /** Select a node of the diagram on screen (spectrace). */
  select?: (node: string) => void;
}

export type Action = (params: URLSearchParams, node: Element | null, ctx: ActionContext) => void;

const registry = new Map<string, Action>();

export function register(name: string, fn: Action): void {
  if (!/^[a-z][\w-]*$/i.test(name)) throw new TypeError(`Invalid action name: ${name}`);
  registry.set(name, fn);
}

// The built-in actions are registered like any other, so a host can replace them.
register("copy", (p, _node, ctx) => {
  const text = p.get("text") ?? "";
  Promise.resolve()
    .then(() => navigator.clipboard.writeText(text))
    .then(
      () => ctx.toast(`Copied: ${text}`),
      () => ctx.toast(`Clipboard blocked here, the text is: ${text}`),
    );
});

register("toggle", (p, node) => {
  const cls = p.get("class");
  if (node && cls) node.classList.toggle(cls);
});

register("show", (p, _node, ctx) => {
  const id = p.get("id");
  const t = id ? ctx.doc.getElementById(id) : null;
  if (!t) return ctx.toast(`No element #${id}`);
  if ("open" in t) (t as HTMLDetailsElement).open = true;
  t.scrollIntoView?.({ behavior: "smooth", block: "center" });
  t.classList.add("flash");
  setTimeout(() => t.classList.remove("flash"), 1500);
});

// spectrace: `action:step?id=checkout.pay` (or `?node=pay`) selects that step of the spec on screen.
register("step", (p, _node, ctx) => {
  const node = p.get("node") ?? p.get("id")?.split(".").pop() ?? "";
  if (!node || !ctx.select) return ctx.toast("No step to select here");
  ctx.select(node);
});

/** `href` must be an `action:` URL. */
export function run(href: string, node: Element | null, ctx: ActionContext): void {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return ctx.toast(`Invalid action link: ${href}`);
  }
  const fn = registry.get(u.pathname);
  if (!fn) return ctx.toast(`Unknown action: ${u.pathname}`);
  try {
    fn(u.searchParams, node, ctx);
  } catch (err) {
    ctx.toast(`Action ${u.pathname} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface MountOptions {
  toast?: (msg: string) => void;
  select?: (node: string) => void;
  /** Called for every other click that has an href (`spec://…`, nav, `#heading`). */
  onLink?: (href: string, a: Element | null, event: MouseEvent) => void;
  /** Listen in the capture phase, to run before the host's own handlers. */
  capture?: boolean;
}

/** One click handler on `root` that runs `action:` links and hands other links to `onLink`. */
export function mount(root: HTMLElement, opts: MountOptions = {}): { destroy: () => void } {
  const ctx: ActionContext = {
    root,
    doc: root.ownerDocument,
    toast: opts.toast ?? ((msg) => console.info("[mermaid-actions]", msg)),
    select: opts.select,
  };
  const onClick = (e: MouseEvent) => {
    if (!(e.target instanceof Element)) return;
    const a = e.target.closest("a");
    const href = a?.getAttribute("href") ?? a?.getAttribute("xlink:href");
    if (!href) return;
    if (href.startsWith("action:")) {
      e.preventDefault();
      e.stopPropagation();
      run(href, nodeIdOf(e.target)?.el ?? null, ctx);
    } else {
      opts.onLink?.(href, a, e);
    }
  };
  const capture = !!opts.capture;
  root.addEventListener("click", onClick, capture);
  return { destroy: () => root.removeEventListener("click", onClick, capture) };
}

// `click id [href] "target" ["tooltip"]`, one per line.
const CLICK = /^\s*click\s+([^\s"]+)\s+(?:href\s+)?"([^"]*)"(?:\s+"([^"]*)")?(?:\s+_?\w+)?\s*$/;

/** Only `action:` targets are returned; real URLs and `#heading` links need no help. */
export function parseClicks(source: string): Record<string, { href: string; tooltip: string }> {
  const out: Record<string, { href: string; tooltip: string }> = Object.create(null);
  for (const line of String(source).split(/\r?\n/)) {
    const m = CLICK.exec(line);
    if (m && m[2]!.startsWith("action:")) out[m[1]!] = { href: m[2]!, tooltip: m[3] ?? "" };
  }
  return out;
}

/** Pele puts the Mermaid id in `data-id`; mermaid.js 10 names nodes `flowchart-<id>-<n>`. */
export function nodeIdOf(target: Element | null): { id: string; el: Element } | null {
  for (let el = target; el && el.nodeType === 1; el = el.parentElement) {
    const d = el.getAttribute("data-id");
    if (d) return { id: d, el };
    const m = /^(?:flowchart|state|class|graph)-(.+)-\d+$/.exec(el.id ?? "");
    if (m) return { id: m[1]!, el };
  }
  return null;
}

export function decorate(root: Element, clicks: Record<string, unknown>, cls = "ma-action"): void {
  for (const el of root.querySelectorAll("[data-id], [id]")) {
    const n = nodeIdOf(el);
    if (n && n.el === el && Object.hasOwn(clicks, n.id)) el.classList.add(cls);
  }
}
