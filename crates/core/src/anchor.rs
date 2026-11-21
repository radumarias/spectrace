//! Anchor scanner: finds the places where code and tests point at a spec.
//!
//! An *anchor* ties a piece of source to a spec id such as `checkout.failed`.
//! The scanner works on text only (no I/O), so callers read the file and pass
//! its path and contents.
//!
//! # Anchor syntax
//!
//! Follows `docs/spec-format.md` (PR #58, proposed) where it applies.
//!
//! | Form | Languages | Meaning |
//! |---|---|---|
//! | `#[spec("id", ...)]` | Rust | attribute at the start of a line; ids are step ids (`checkout.failed`) or requirement ids (`checkout.failed/r2`); several attributes may share a line |
//! | `// @flow step.id: note` | Rust, TypeScript | line comment (`//` or `///`) |
//! | `# @flow step.id: note` | Python | line comment |
//!
//! `#[spec]` is Rust only, as in the doc. The `@flow` comment form is used for
//! TypeScript and Python too. A `@flow` comment without a `:` note is still
//! returned (with `note: None`) so the checker can report `A003`; one without a
//! valid id is not an anchor. Arguments of `#[spec]` that are not valid ids are
//! dropped here, so the checker cannot see them (`A002`); that is a gap to close
//! when the checker is written.
//!
//! # Code or test
//!
//! An anchor is [`AnchorClass::Test`] when any of these hold, otherwise
//! [`AnchorClass::Code`]:
//!
//! * the path looks like a test file (see [`is_test_path`]);
//! * it sits in a test block that starts at column 0: a `#[cfg(test)]` module or
//!   `#[test]` function in Rust, a `def test_…` or `class Test…` in Python, a
//!   top-level `describe(`, `it(` or `test(` in TypeScript;
//! * it is attached to such an item, meaning the first code line after the
//!   anchor (skipping blank lines, comments, attributes and decorators) starts
//!   one, or a Rust attribute in between is a test attribute.
//!
//! These are heuristics, not a parser; they are meant to be right for code
//! written the usual way.

/// A source language the scanner understands.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Language {
    Rust,
    TypeScript,
    Python,
}

impl Language {
    /// Picks the language from the file extension, or `None` for other files.
    pub fn from_path(path: &str) -> Option<Language> {
        let ext = path.rsplit_once('.')?.1;
        match ext {
            "rs" => Some(Language::Rust),
            "ts" | "tsx" | "mts" | "cts" => Some(Language::TypeScript),
            "py" => Some(Language::Python),
            _ => None,
        }
    }
}

/// What kind of anchor was found.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AnchorKind {
    /// `#[spec("id")]`: implements the id, or covers it when the item is a test.
    Spec,
    /// `@flow` comment: marks where a step's decision is made. Not coverage.
    Flow,
}

/// Whether the anchored source is product code or a test.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum AnchorClass {
    Code,
    Test,
}

/// One anchor found in a file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Anchor {
    pub language: Language,
    pub kind: AnchorKind,
    pub id: String,
    /// The note after the colon of a `@flow` comment. Always `None` for specs.
    pub note: Option<String>,
    /// 1-based line number.
    pub line: usize,
    pub class: AnchorClass,
}

/// The one place that defines what an id looks like (spec format, "Ids"):
/// a segment is `[a-z][a-z0-9_]*`, 1 to 40 characters.
pub fn is_valid_segment(seg: &str) -> bool {
    let mut chars = seg.chars();
    (1..=40).contains(&seg.len())
        && matches!(chars.next(), Some(c) if c.is_ascii_lowercase())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

/// A step id: `flow.node`, such as `checkout.failed`.
pub fn is_valid_step_id(id: &str) -> bool {
    matches!(id.split_once('.'), Some((flow, node)) if is_valid_segment(flow) && is_valid_segment(node))
}

/// A requirement id: a step id, `/`, and a tag `r<positive integer>`, such as
/// `checkout.failed/r2`.
pub fn is_valid_req_id(id: &str) -> bool {
    let Some((step, tag)) = id.split_once('/') else {
        return false;
    };
    let digits = tag.strip_prefix('r').unwrap_or("");
    is_valid_step_id(step)
        && !digits.is_empty()
        && !digits.starts_with('0')
        && digits.chars().all(|c| c.is_ascii_digit())
}

/// Anything `#[spec(...)]` may name: a step id or a requirement id.
pub fn is_valid_id(id: &str) -> bool {
    is_valid_step_id(id) || is_valid_req_id(id)
}

/// True when the path alone says the file is a test file.
pub fn is_test_path(path: &str) -> bool {
    let path = path.replace('\\', "/");
    let mut parts: Vec<&str> = path.split('/').collect();
    let file = parts.pop().unwrap_or("");
    if parts
        .iter()
        .any(|d| matches!(*d, "tests" | "test" | "__tests__" | "e2e"))
    {
        return true;
    }
    let stem = file.rsplit_once('.').map_or(file, |(s, _)| s);
    stem == "tests"
        || stem == "conftest"
        || stem.ends_with(".test")
        || stem.ends_with(".spec")
        || stem.ends_with("_test")
        || stem.starts_with("test_")
}

/// Scans one file. Unknown file types give no anchors.
pub fn scan(path: &str, source: &str) -> Vec<Anchor> {
    let Some(language) = Language::from_path(path) else {
        return Vec::new();
    };
    let test_path = is_test_path(path);
    let lines: Vec<&str> = source.lines().collect();
    let mut anchors = Vec::new();
    let mut block = BlockState::default();

    for (i, line) in lines.iter().enumerate() {
        block.update(language, line);
        let found = line_anchors(language, line);
        if found.is_empty() {
            continue;
        }
        let class = if test_path || block.in_test || attached_to_test(language, &lines[i + 1..]) {
            AnchorClass::Test
        } else {
            AnchorClass::Code
        };
        for (kind, id, note) in found {
            anchors.push(Anchor {
                language,
                kind,
                id,
                note,
                line: i + 1,
                class,
            });
        }
    }
    anchors
}

/// Tracks whether the scan is inside a test block that began at column 0.
#[derive(Default)]
struct BlockState {
    in_test: bool,
    /// Rust: a test attribute was seen at column 0 and its item has not started.
    pending_test_attr: bool,
}

impl BlockState {
    fn update(&mut self, language: Language, line: &str) {
        if line.is_empty() || line.starts_with([' ', '\t']) {
            return;
        }
        match language {
            Language::Rust => {
                if line.starts_with("#[") {
                    if is_rust_test_attr(line) {
                        self.pending_test_attr = true;
                    }
                } else if !is_comment_line(language, line) {
                    self.in_test = self.pending_test_attr && line.trim_end().ends_with('{');
                    self.pending_test_attr = false;
                }
            }
            Language::TypeScript => {
                if !is_comment_line(language, line) && !line.starts_with('@') {
                    self.in_test = starts_ts_test_item(line);
                }
            }
            Language::Python => {
                if !is_comment_line(language, line) && !line.starts_with('@') {
                    self.in_test = starts_py_test_item(line);
                }
            }
        }
    }
}

fn is_comment_line(language: Language, line: &str) -> bool {
    let t = line.trim_start();
    match language {
        Language::Python => t.starts_with('#'),
        _ => t.starts_with("//") || t.starts_with("/*") || t.starts_with('*'),
    }
}

fn is_rust_test_attr(line: &str) -> bool {
    let t = line.trim();
    t.starts_with("#[cfg(test)]")
        || t.starts_with("#[test]")
        || t.starts_with("#[test ")
        || t.contains("::test]")
        || t.contains("::test(")
}

fn starts_ts_test_item(line: &str) -> bool {
    ["describe", "it", "test"].iter().any(|name| {
        line.strip_prefix(name)
            .is_some_and(|rest| rest.starts_with('(') || rest.starts_with('.'))
    })
}

fn starts_py_test_item(line: &str) -> bool {
    let rest = line.strip_prefix("async ").unwrap_or(line);
    rest.starts_with("def test_") || rest.starts_with("class Test")
}

/// Looks at what comes after an anchor: the first code line decides.
fn attached_to_test(language: Language, following: &[&str]) -> bool {
    let mut test_attr = false;
    for line in following {
        let t = line.trim();
        if t.is_empty() || is_comment_line(language, t) {
            continue;
        }
        match language {
            Language::Rust => {
                if t.starts_with("#[") {
                    test_attr |= is_rust_test_attr(t);
                    continue;
                }
                return test_attr;
            }
            Language::TypeScript => {
                if t.starts_with('@') {
                    continue;
                }
                return starts_ts_test_item(t);
            }
            Language::Python => {
                if t.starts_with('@') {
                    continue;
                }
                return starts_py_test_item(t);
            }
        }
    }
    false
}

type Found = (AnchorKind, String, Option<String>);

/// All anchors on one line, in order.
fn line_anchors(language: Language, line: &str) -> Vec<Found> {
    let mut out = Vec::new();

    if language == Language::Rust {
        let mut rest = line.trim_start();
        while let Some(args) = rest.strip_prefix("#[spec(") {
            let (ids, after) = string_args(args);
            out.extend(ids.into_iter().map(|id| (AnchorKind::Spec, id, None)));
            rest = after.trim_start();
            rest = rest.strip_prefix(")]").unwrap_or(rest).trim_start();
        }
    }

    if let Some(comment) = comment_text(language, line) {
        if let Some(flow) = flow_anchor(comment) {
            out.push(flow);
        }
    }
    out
}

/// The text of a line comment (`//`, `///` or `#` for Python), if the line has one.
fn comment_text(language: Language, line: &str) -> Option<&str> {
    match language {
        Language::Python => line.find('#').map(|i| &line[i + 1..]),
        _ => line
            .find("//")
            .map(|i| line[i + 2..].trim_start_matches(['/', '!'])),
    }
}

/// Parses `@flow <step-id>[: note]` out of comment text.
fn flow_anchor(comment: &str) -> Option<Found> {
    let after = comment.trim_start().strip_prefix("@flow")?;
    if !after.starts_with([' ', '\t']) {
        return None;
    }
    let after = after.trim_start();
    let end = after
        .find(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '.')))
        .unwrap_or(after.len());
    let (id, rest) = after.split_at(end);
    if !is_valid_step_id(id) {
        return None;
    }
    let note = rest
        .trim_start()
        .strip_prefix(':')
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(str::to_string);
    Some((AnchorKind::Flow, id.to_string(), note))
}

/// Reads the quoted ids of a call, from just after `(`. Stops at the first
/// thing that is not a string, comma or whitespace and returns the rest.
fn string_args(args: &str) -> (Vec<String>, &str) {
    let mut ids = Vec::new();
    let mut rest = args;
    loop {
        rest = rest.trim_start_matches(|c: char| c == ',' || c.is_whitespace());
        let Some(quote) = rest.chars().next().filter(|c| *c == '"') else {
            break;
        };
        let body = &rest[quote.len_utf8()..];
        let Some(close) = body.find(quote) else {
            rest = "";
            break;
        };
        if is_valid_id(&body[..close]) {
            ids.push(body[..close].to_string());
        }
        rest = &body[close + 1..];
    }
    (ids, rest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids() {
        assert!(is_valid_step_id("checkout.failed"));
        assert!(is_valid_step_id("pay.card_declined_2"));
        assert!(!is_valid_step_id("checkout"));
        assert!(!is_valid_step_id("checkout.failed.x"));
        assert!(!is_valid_step_id("Checkout.failed"));
        assert!(!is_valid_step_id("checkout.card-declined"));
        assert!(!is_valid_step_id("checkout..failed"));
        assert!(!is_valid_step_id("1cart.add"));
        assert!(!is_valid_step_id(&format!("a.{}", "b".repeat(41))));
        assert!(is_valid_req_id("checkout.failed/r2"));
        assert!(is_valid_req_id("checkout.failed/r10"));
        assert!(!is_valid_req_id("checkout.failed/r0"));
        assert!(!is_valid_req_id("checkout.failed/r"));
        assert!(!is_valid_req_id("checkout.failed/2"));
        assert!(is_valid_id("checkout.failed") && is_valid_id("checkout.failed/r1"));
        assert!(!is_valid_id(""));
    }

    #[test]
    fn languages_by_extension() {
        assert_eq!(Language::from_path("a/b.rs"), Some(Language::Rust));
        assert_eq!(Language::from_path("a.tsx"), Some(Language::TypeScript));
        assert_eq!(Language::from_path("a.py"), Some(Language::Python));
        assert_eq!(Language::from_path("a.md"), None);
        assert_eq!(Language::from_path("Makefile"), None);
    }

    #[test]
    fn test_paths() {
        assert!(is_test_path("crates/server/tests/checkout.rs"));
        assert!(is_test_path("web/src/cart.test.ts"));
        assert!(is_test_path("web/src/__tests__/cart.ts"));
        assert!(is_test_path("app/test_pay.py"));
        assert!(is_test_path("app/pay_test.py"));
        assert!(is_test_path("app/conftest.py"));
        assert!(!is_test_path("crates/server/src/checkout.rs"));
        assert!(!is_test_path("web/src/cart.ts"));
        assert!(!is_test_path("app/latest.py"));
    }

    #[test]
    fn unknown_files_give_nothing() {
        assert!(scan("README.md", "// @flow checkout.failed: x").is_empty());
    }

    #[test]
    fn invalid_ids_are_ignored() {
        assert!(scan("a.rs", "#[spec(\"Not An Id\")]\nfn f() {}\n").is_empty());
        assert!(scan("a.py", "# @flow Bad.Id: x\n").is_empty());
        assert!(scan("a.py", "# @flow checkout\n").is_empty());
    }

    #[test]
    fn spec_is_rust_only() {
        assert!(scan("a.ts", "@spec(\"cart.add\")\n// #[spec(\"cart.add\")]\n").is_empty());
        assert!(scan("a.py", "#[spec(\"cart.add\")]\n").is_empty());
    }

    #[test]
    fn flow_note_is_optional() {
        let got = scan("a.py", "# @flow cart.add: cap at 99\n# @flow cart.remove\n");
        assert_eq!(got[0].note.as_deref(), Some("cap at 99"));
        assert_eq!(got[1].note, None);
    }

    #[test]
    fn several_attributes_on_one_line() {
        let got = scan(
            "a.rs",
            "#[spec(\"cart.add\")] #[spec(\"cart.remove/r1\")] fn f() {}\n",
        );
        let ids: Vec<&str> = got.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, ["cart.add", "cart.remove/r1"]);
    }

    #[test]
    fn several_ids_in_one_attribute() {
        let got = scan(
            "a.rs",
            "#[spec(\"cart.add\", \"cart.remove\")]\nfn f() {}\n",
        );
        let ids: Vec<&str> = got.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(ids, ["cart.add", "cart.remove"]);
        assert!(got.iter().all(|a| a.line == 1));
    }

    #[test]
    fn commented_out_attribute_is_not_an_anchor() {
        assert!(scan("a.rs", "// #[spec(\"cart.add\")]\n").is_empty());
    }
}
