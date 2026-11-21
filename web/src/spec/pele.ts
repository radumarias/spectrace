// pele (MIT, github.com/obsidianmd/pele) is the Mermaid renderer devpage draws
// its diagrams with; this is the same version devpage vendors. Specs only use
// flowcharts, so only that diagram type is registered. Loaded on demand, so
// pages without a diagram do not pay for it.
import { register, render } from "pele/core";
import flowchart from "pele/diagrams/flowchart";

register(flowchart);

export interface Drawn {
  svg: string;
  width: number;
  height: number;
}

/**
 * Draws Mermaid text to an SVG string. `click … href` lines become links:
 * `spec://<step>` (a step of the spec) and `action:<name>?…` (mermaid-actions,
 * see actions.ts) are run by the diagram instead of followed; http(s) and mailto
 * stay plain links, as in devpage. Throws pele's error when the text does not parse.
 */
export function draw(source: string, idPrefix = "spec-dia"): Drawn {
  const out = render(source, { linkSchemes: ["http", "https", "mailto", "spec", "action"], idPrefix });
  return { svg: out.svg, width: out.width, height: out.height };
}
