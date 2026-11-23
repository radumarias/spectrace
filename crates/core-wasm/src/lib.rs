//! WASM boundary of `spectrace-core` for the Worker.
//!
//! Thin on purpose: each export takes plain strings, calls one `spectrace-core`
//! function and returns plain data (serialized to JS objects). `spectrace-core`
//! itself stays free of I/O and of wasm dependencies. The TypeScript types of
//! the results are declared in [`TS_TYPES`] and end up in the generated `.d.ts`.
//!
//! To expose another core function, make its result `Serialize` (the `serde`
//! feature of `spectrace-core`, or a DTO here), add one `#[wasm_bindgen]` function and its types in `TS_TYPES`.

use serde::{Deserialize, Serialize};
use spectrace_core::anchor::{self, AnchorClass, AnchorKind, Language};
use spectrace_core::spec;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(typescript_custom_section)]
const TS_TYPES: &str = r#"
export type GateStatus = "pass" | "open" | "unchecked";
export interface Gate { id: "review" | "findings" | "mapping" | "tests" | "approval"; label: string; status: GateStatus }
export interface GateInput {
  reviewFinished: boolean;
  openSeriousFindings: number;
  checksTotal: number;
  checksFailed: number;
  checksPending: number;
  approvals: number;
  critical: boolean;
  /** `null` while mapping files to specs is not available. */
  filesMapped: boolean | null;
}

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
/** One edit of a spec, for `editSpec`. Steps are named by node id, edges by all three parts. */
export type SpecEdit =
  | { op: "addStep"; node: string; label: string; from?: string | null; edgeLabel?: string | null }
  | { op: "removeStep"; node: string }
  | { op: "renameStep"; node: string; label: string }
  | { op: "addEdge"; from: string; label: string; to: string }
  | { op: "removeEdge"; from: string; label: string; to: string }
  | { op: "relabelEdge"; from: string; label: string; to: string; newLabel: string }
  | { op: "addRequirement"; node: string; condition: string; response: string }
  | { op: "setRequirement"; node: string; tag: string; condition: string; response: string }
  | { op: "removeRequirement"; node: string; tag: string };
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

/// One edit of a spec, as the diagram editor makes them. See `SpecEdit` in [`TS_TYPES`].
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum SpecEdit {
    AddStep {
        node: String,
        label: String,
        #[serde(default)]
        from: Option<String>,
        #[serde(default)]
        edge_label: Option<String>,
    },
    RemoveStep {
        node: String,
    },
    RenameStep {
        node: String,
        label: String,
    },
    AddEdge {
        from: String,
        label: String,
        to: String,
    },
    RemoveEdge {
        from: String,
        label: String,
        to: String,
    },
    RelabelEdge {
        from: String,
        label: String,
        to: String,
        new_label: String,
    },
    AddRequirement {
        node: String,
        condition: String,
        response: String,
    },
    SetRequirement {
        node: String,
        tag: String,
        condition: String,
        response: String,
    },
    RemoveRequirement {
        node: String,
        tag: String,
    },
}

/// Applies one edit to the spec in `source` and returns the new file text,
/// written back by `spectrace_core::write` so only the touched lines change.
/// Refuses a file with errors, an edit that names nothing, and any edit whose
/// result would not parse back to the edited spec.
pub fn edit(path: &str, source: &str, op: &SpecEdit) -> Result<String, String> {
    let parsed = spec::parse(path, source);
    if parsed.has_errors() {
        return Err("the spec has errors; fix them before editing".into());
    }
    let original = parsed.spec;
    let mut s = original.clone();
    let missing = |what: &str| Err::<String, String>(format!("no {what}"));
    match op {
        SpecEdit::AddStep {
            node,
            label,
            from,
            edge_label,
        } => {
            if node.contains('.') || !anchor::is_valid_id(&format!("{}.{node}", original.flow)) {
                return Err(format!("{node:?} is not a valid step id"));
            }
            if !s.add_step(node, label, label) {
                return Err(format!("step {node} already exists"));
            }
            if let Some(from) = from {
                if s.diagram.as_ref().and_then(|d| d.node(from)).is_none() {
                    return missing(&format!("step {from}"));
                }
                s.add_edge(from, edge_label.as_deref().unwrap_or(""), node);
            }
        }
        SpecEdit::RemoveStep { node } => {
            if !s.remove_step(node) {
                return missing(&format!("step {node}"));
            }
        }
        SpecEdit::RenameStep { node, label } => {
            let Some(n) = s.diagram.as_mut().and_then(|d| d.node_mut(node)) else {
                return missing(&format!("step {node}"));
            };
            n.label = label.clone();
            if let Some(sec) = s.section_mut(node) {
                sec.title = label.clone();
            }
        }
        SpecEdit::AddEdge { from, label, to } => {
            let d = s.diagram.as_ref();
            for n in [from, to] {
                if d.and_then(|d| d.node(n)).is_none() {
                    return missing(&format!("step {n}"));
                }
            }
            if !s.add_edge(from, label, to) {
                return Err(format!("the arrow {from} -> {to} already exists"));
            }
        }
        SpecEdit::RemoveEdge { from, label, to } => {
            if !s.remove_edge(from, label, to) {
                return missing(&format!("arrow {from} -> {to}"));
            }
        }
        SpecEdit::RelabelEdge {
            from,
            label,
            to,
            new_label,
        } => {
            let Some(e) = s.diagram.as_mut().and_then(|d| {
                d.edges
                    .iter_mut()
                    .find(|e| &e.from == from && &e.label == label && &e.to == to)
            }) else {
                return missing(&format!("arrow {from} -> {to}"));
            };
            e.label = new_label.clone();
        }
        SpecEdit::AddRequirement {
            node,
            condition,
            response,
        } => {
            let before = original.sections.iter().find(|x| &x.node == node).cloned();
            let Some(sec) = s.section_mut(node) else {
                return missing(&format!("section for step {node}"));
            };
            sec.add_requirement(condition, response, before.as_ref());
        }
        SpecEdit::SetRequirement {
            node,
            tag,
            condition,
            response,
        } => {
            let Some(r) = s.section_mut(node).and_then(|x| x.requirement_mut(tag)) else {
                return missing(&format!("requirement {node}/{tag}"));
            };
            r.condition = condition.clone();
            r.response = response.clone();
        }
        SpecEdit::RemoveRequirement { node, tag } => {
            let Some(sec) = s.section_mut(node) else {
                return missing(&format!("section for step {node}"));
            };
            let before = sec.requirements.len();
            sec.requirements.retain(|r| &r.tag != tag);
            if sec.requirements.len() == before {
                return missing(&format!("requirement {node}/{tag}"));
            }
        }
    }
    spectrace_core::write::write(source, &original, &s).map_err(|e| e.to_string())
}

/// Applies one `SpecEdit` to a spec file and returns its new text (`edit`).
/// Throws with a reason when the edit cannot be made.
#[wasm_bindgen(js_name = editSpec)]
pub fn edit_spec(
    path: &str,
    source: &str,
    #[wasm_bindgen(unchecked_param_type = "SpecEdit")] op: JsValue,
) -> Result<String, JsError> {
    let op: SpecEdit = serde_wasm_bindgen::from_value(op)?;
    edit(path, source, &op).map_err(|e| JsError::new(&e))
}

/// Whether `id` is a valid step or requirement id (`anchor::is_valid_id`).
/// The merge gates of a pull request (`gate::evaluate`), in the order the page lists them.
#[wasm_bindgen(js_name = evaluateGates, unchecked_return_type = "Gate[]")]
pub fn evaluate_gates(
    #[wasm_bindgen(unchecked_param_type = "GateInput")] input: JsValue,
) -> Result<JsValue, JsError> {
    let input: spectrace_core::gate::GateInput = serde_wasm_bindgen::from_value(input)?;
    Ok(to_js(&spectrace_core::gate::evaluate(&input))?)
}

#[wasm_bindgen(js_name = isValidId)]
pub fn is_valid_id(id: &str) -> bool {
    anchor::is_valid_id(id)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
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

    const CHECKOUT: &str = include_str!("../../../fixtures/shop/spec/checkout.md");
    const PATH: &str = "spec/checkout.md";

    fn op(json: &str) -> SpecEdit {
        serde_json::from_str(json).expect("valid edit")
    }

    /// The lines of `after` that are not in `before`, and the other way round.
    fn changed(before: &str, after: &str) -> (Vec<String>, Vec<String>) {
        let b: Vec<&str> = before.lines().collect();
        let a: Vec<&str> = after.lines().collect();
        (
            a.iter()
                .filter(|l| !b.contains(l))
                .map(|l| l.to_string())
                .collect(),
            b.iter()
                .filter(|l| !a.contains(l))
                .map(|l| l.to_string())
                .collect(),
        )
    }

    #[test]
    fn renames_a_step_on_the_diagram_and_its_heading() {
        let out = edit(
            PATH,
            CHECKOUT,
            &op(r#"{"op":"renameStep","node":"failed","label":"Payment declined"}"#),
        )
        .unwrap();
        let (added, removed) = changed(CHECKOUT, &out);
        assert_eq!(
            added,
            [
                "  failed[Payment declined]",
                "## Payment declined {#checkout.failed}"
            ]
        );
        assert_eq!(
            removed,
            [
                "  failed[Declined]",
                "## Declined payment {#checkout.failed}"
            ]
        );
    }

    #[test]
    fn adds_a_step_with_an_arrow_and_its_click_and_section() {
        let out = edit(
            PATH,
            CHECKOUT,
            &op(r#"{"op":"addStep","node":"refunded","label":"Refunded","from":"paid","edgeLabel":"refund"}"#),
        )
        .unwrap();
        let parsed = spec::parse(PATH, &out);
        assert!(!parsed.has_errors(), "{:?}", parsed.diagnostics);
        let (added, removed) = changed(CHECKOUT, &out);
        assert!(removed.is_empty(), "{removed:?}");
        assert!(
            added.contains(&"  refunded[Refunded]".to_string()),
            "{added:?}"
        );
        assert!(
            added.contains(&"  paid -->|refund| refunded".to_string()),
            "{added:?}"
        );
        assert!(
            added.contains(&"## Refunded {#checkout.refunded}".to_string()),
            "{added:?}"
        );
    }

    #[test]
    fn removes_a_step_with_its_arrows_and_section() {
        let out = edit(
            PATH,
            CHECKOUT,
            &op(r#"{"op":"removeStep","node":"details"}"#),
        )
        .unwrap();
        assert!(!spec::parse(PATH, &out).has_errors());
        assert!(!out.contains("details"), "{out}");
        assert!(out.contains("## Pay {#checkout.pay}"));
    }

    #[test]
    fn adds_relabels_and_removes_arrows() {
        let out = edit(
            PATH,
            CHECKOUT,
            &op(r#"{"op":"addEdge","from":"details","label":"back","to":"cart"}"#),
        )
        .unwrap();
        assert_eq!(changed(CHECKOUT, &out).0, ["  details -->|back| cart"]);
        let out2 = edit(PATH, &out, &op(r#"{"op":"relabelEdge","from":"details","label":"back","to":"cart","newLabel":"edit cart"}"#)).unwrap();
        assert_eq!(
            changed(&out, &out2),
            (
                vec!["  details -->|edit cart| cart".to_string()],
                vec!["  details -->|back| cart".to_string()]
            )
        );
        let out3 = edit(
            PATH,
            &out2,
            &op(r#"{"op":"removeEdge","from":"details","label":"edit cart","to":"cart"}"#),
        )
        .unwrap();
        assert_eq!(out3, CHECKOUT);
    }

    #[test]
    fn edits_requirement_lines_with_the_next_free_tag() {
        let out = edit(PATH, CHECKOUT, &op(r#"{"op":"addRequirement","node":"paid","condition":"the receipt bounces","response":"show it in the order"}"#)).unwrap();
        assert_eq!(
            changed(CHECKOUT, &out).0,
            ["- WHEN the receipt bounces THE SYSTEM SHALL show it in the order. {#r2}"]
        );
        let out = edit(PATH, CHECKOUT, &op(r#"{"op":"setRequirement","node":"failed","tag":"r2","condition":"a decline goes past the retry limit of 5","response":"cancel the order"}"#)).unwrap();
        assert_eq!(changed(CHECKOUT, &out).0, ["- WHEN a decline goes past the retry limit of 5 THE SYSTEM SHALL cancel the order. {#r2}"]);
        let out = edit(
            PATH,
            CHECKOUT,
            &op(r#"{"op":"removeRequirement","node":"cart","tag":"r1"}"#),
        )
        .unwrap();
        assert_eq!(
            changed(CHECKOUT, &out).1,
            ["- WHEN the cart is empty THE SYSTEM SHALL disable the checkout button. {#r1}"]
        );
    }

    #[test]
    fn refuses_edits_that_name_nothing_or_break_the_spec() {
        for (json, why) in [
            (r#"{"op":"removeStep","node":"nope"}"#, "no step nope"),
            (
                r#"{"op":"addStep","node":"pay","label":"Pay again"}"#,
                "already exists",
            ),
            (
                r#"{"op":"addStep","node":"Bad Id","label":"x"}"#,
                "not a valid step id",
            ),
            (
                r#"{"op":"addEdge","from":"cart","label":"start","to":"details"}"#,
                "already exists",
            ),
            (
                r#"{"op":"setRequirement","node":"cart","tag":"r9","condition":"a","response":"b"}"#,
                "no requirement cart/r9",
            ),
        ] {
            let err = edit(PATH, CHECKOUT, &op(json)).unwrap_err();
            assert!(err.contains(why), "{json}: {err}");
        }
        assert!(edit(
            PATH,
            "# Broken {#broken}\n",
            &op(r#"{"op":"removeStep","node":"x"}"#)
        )
        .unwrap_err()
        .contains("errors"));
    }
}
