// Types of requirements sets, without spectrace-core, so the routes (and the
// OpenAPI generator, which runs in Node without the WASM) can load them.
import type { Diagnostic, Spec } from "./core";

export const VIEW_KINDS = ["mockup", "diagram", "note"] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

export interface DraftFlow {
  flow: string;
  title: string;
  source: string;
}
export interface DraftView {
  id: string;
  /** The step or requirement id the view illustrates; null for the whole set. */
  of: string | null;
  kind: ViewKind;
  title: string;
  text: string;
}
export interface DraftSet {
  title: string;
  flows: DraftFlow[];
  views: DraftView[];
}
export interface CheckedFlow extends DraftFlow {
  path: string;
  model: Spec | null;
  diagnostics: Diagnostic[];
}
