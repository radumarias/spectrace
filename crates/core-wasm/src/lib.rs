//! WASM boundary of `spectrace-core` for the Worker.
//!
//! Thin on purpose: each export takes plain strings, calls one `spectrace-core`
//! function and returns plain data (serialized to JS objects). `spectrace-core`
//! itself stays free of I/O and of wasm dependencies. The TypeScript types of
//! the results are declared in [`TS_TYPES`] and end up in the generated `.d.ts`.
//!
//! To expose another core function, make its result `Serialize` (the `serde`
//! feature of `spectrace-core`, or a DTO here), add one `#[wasm_bindgen]` function and its types in `TS_TYPES`.

use serde::Serialize;
use spectrace_core::anchor::{self, AnchorClass, AnchorKind, Language};
use spectrace_core::spec;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(typescript_custom_section)]
const TS_TYPES: &str = r#"
export type Language = "rust" | "typescript" | "python";
export type AnchorKind = "spec" | "flow";
export type AnchorClass = "code" | "test";
export interface Anchor {
  language: Language;
  kind: AnchorKind;
  id: string;
  note: string | null;
  /** 1-based line number. */
  line: number;
  class: AnchorClass;
}

/** A byte range `start..end` in the parsed source. */
export interface Span { start: number; end: number }
export type DiagnosticCode =
  | "S001" | "S002" | "S003" | "S004" | "S005" | "S006" | "S007"
  | "S008" | "S009" | "S010" | "S011" | "S012" | "S013" | "S014" | "S015"
  | "W001" | "W002" | "W003";
export interface Diagnostic { code: DiagnosticCode; file: string; line: number; message: string }
export interface Title { text: string; id: string; line: number; span: Span }
export interface Located { line: number; span: Span }
export interface DiagramNode { id: string; label: string; line: number; span: Span }
export interface Edge { from: string; label: string; to: string; line: number; span: Span }
export interface Click { node: string; target: string; line: number; span: Span }
export interface Action { node: string; href: string; name: string; tooltip: string | null; line: number; span: Span }
export interface Comment { text: string; line: number; span: Span }
export interface Diagram {
  direction: "LR" | "RL" | "TD" | "TB" | "BT" | null;
  line: number;
  span: Span;
  body: Span;
  header: Located | null;
  nodes: DiagramNode[];
  edges: Edge[];
  clicks: Click[];
  actions: Action[];
  comments: Comment[];
}
export interface Requirement {
  tag: string;
  condition: string;
  response: string;
  line: number;
  end_line: number;
  span: Span;
}
export interface FlowQuote { text: string; line: number; end_line: number; span: Span }
export interface Section {
  id: string;
  node: string;
  title: string;
  line: number;
  heading: Span;
  span: Span;
  requirements: Requirement[];
  flow: FlowQuote | null;
}
export interface Spec {
  flow: string;
  title: Title | null;
  diagram: Diagram | null;
  sections: Section[];
  head: Span;
}
/** Trust `spec` only when no diagnostic has a code starting with `S`. */
export interface ParsedSpec { spec: Spec; diagnostics: Diagnostic[] }
"#;

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum LanguageDto {
    Rust,
    Typescript,
    Python,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum KindDto {
    Spec,
    Flow,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum ClassDto {
    Code,
    Test,
}

#[derive(Serialize)]
struct AnchorDto {
    language: LanguageDto,
    kind: KindDto,
    id: String,
    note: Option<String>,
    line: usize,
    class: ClassDto,
}

impl From<anchor::Anchor> for AnchorDto {
    fn from(a: anchor::Anchor) -> Self {
        AnchorDto {
            language: match a.language {
                Language::Rust => LanguageDto::Rust,
                Language::TypeScript => LanguageDto::Typescript,
                Language::Python => LanguageDto::Python,
            },
            kind: match a.kind {
                AnchorKind::Spec => KindDto::Spec,
                AnchorKind::Flow => KindDto::Flow,
            },
            id: a.id,
            note: a.note,
            line: a.line,
            class: match a.class {
                AnchorClass::Code => ClassDto::Code,
                AnchorClass::Test => ClassDto::Test,
            },
        }
    }
}

/// Serializes to a plain JS value. `None` becomes `null`, as the TypeScript
/// types say (the default would be `undefined`).
fn to_js<T: Serialize>(value: &T) -> Result<JsValue, serde_wasm_bindgen::Error> {
    value.serialize(&serde_wasm_bindgen::Serializer::new().serialize_missing_as_null(true))
}

/// The scanned anchors as plain data, shared by the export and the Rust tests.
fn scan_dtos(path: &str, source: &str) -> Vec<AnchorDto> {
    anchor::scan(path, source)
        .into_iter()
        .map(AnchorDto::from)
        .collect()
}

/// Scans one file for spec anchors (`anchor::scan`). Unknown file types give `[]`.
#[wasm_bindgen(js_name = scanAnchors, unchecked_return_type = "Anchor[]")]
pub fn scan_anchors(path: &str, source: &str) -> Result<JsValue, JsError> {
    Ok(to_js(&scan_dtos(path, source))?)
}

/// Parses one spec file (`spec::parse`). Never throws on bad input: problems are
/// in `diagnostics` (codes starting with `S` are errors, `W` warnings).
#[wasm_bindgen(js_name = parseSpec, unchecked_return_type = "ParsedSpec")]
pub fn parse_spec(path: &str, source: &str) -> Result<JsValue, JsError> {
    Ok(to_js(&spec::parse(path, source))?)
}

/// Whether `id` is a valid step or requirement id (`anchor::is_valid_id`).
#[wasm_bindgen(js_name = isValidId)]
pub fn is_valid_id(id: &str) -> bool {
    anchor::is_valid_id(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dto_matches_core() {
        let src = "// @flow checkout.pay: charge the card\n";
        let dtos = scan_dtos("a.ts", src);
        assert_eq!(dtos.len(), 1);
        assert_eq!(dtos[0].id, "checkout.pay");
        assert_eq!(dtos[0].line, 1);
    }
}
