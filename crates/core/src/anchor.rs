//! Anchor scanner: finds the places where code and tests point at a spec.
//!
//! An *anchor* ties a piece of source to a spec id such as `checkout.failed`.
//! The scanner works on text only (no I/O), so callers read the file and pass
//! its path and contents.
//!
//! # Anchor syntax (assumed until the T4.1 spec format doc lands)
//!
//! | Form | Languages | Meaning |
//! |---|---|---|
//! | `#[spec("id")]` | Rust | attribute at the start of a line; several ids may be listed |
//! | `@spec("id")` | TypeScript, Python | decorator at the start of a line; several ids may be listed |
//! | `// @spec id` or `# @spec id` | all | comment form of a spec anchor |
//! | `// @flow id` or `# @flow id` | all | comment that marks a step of a flow |
//!
//! Comment forms also accept the call form (`// @spec("id")`). Rust and
//! TypeScript use `//` and `/* */` comments, Python uses `#`.
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
    /// Ties the code or test to a spec.
    Spec,
    /// Marks a step of a flow.
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
    /// 1-based line number.
    pub line: usize,
    pub class: AnchorClass,
}

/// The one place that defines what a spec or flow id looks like: dot-separated
/// segments, each starting with a lowercase letter and continuing with
/// lowercase letters, digits, `_` or `-` (for example `checkout.failed`).
pub fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.split('.').all(|seg| {
            let mut chars = seg.chars();
            matches!(chars.next(), Some(c) if c.is_ascii_lowercase())
                && chars
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
        })
}

/// Characters that may appear in an id when it is read from a comment.
fn is_id_char(c: char) -> bool {
    c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '_' | '-' | '.')
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
        for (kind, id) in found {
            anchors.push(Anchor {
                language,
                kind,
                id,
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

/// All anchors on one line, in order.
fn line_anchors(language: Language, line: &str) -> Vec<(AnchorKind, String)> {
    let mut out = Vec::new();
    let trimmed = line.trim_start();

    // Attribute or decorator form at the start of the line.
    let call_marker = match language {
        Language::Rust => "#[spec(",
        _ => "@spec(",
    };
    if let Some(args) = trimmed.strip_prefix(call_marker) {
        for id in string_args(args) {
            out.push((AnchorKind::Spec, id));
        }
    }

    // Comment forms.
    if let Some(comment) = comment_text(language, line) {
        scan_comment(comment, &mut out);
    }
    out
}

/// The comment part of a line, if it has one.
fn comment_text(language: Language, line: &str) -> Option<&str> {
    match language {
        Language::Python => line.find('#').map(|i| &line[i + 1..]),
        _ => {
            if let Some(i) = line.find("//") {
                Some(&line[i + 2..])
            } else if let Some(i) = line.find("/*") {
                Some(&line[i + 2..])
            } else if line.trim_start().starts_with('*') {
                Some(line.trim_start())
            } else {
                None
            }
        }
    }
}

/// Finds `@spec` and `@flow` in comment text.
fn scan_comment(comment: &str, out: &mut Vec<(AnchorKind, String)>) {
    let mut rest = comment;
    while let Some(at) = rest.find('@') {
        let tail = &rest[at + 1..];
        let (kind, after) = if let Some(a) = tail.strip_prefix("spec") {
            (AnchorKind::Spec, a)
        } else if let Some(a) = tail.strip_prefix("flow") {
            (AnchorKind::Flow, a)
        } else {
            rest = tail;
            continue;
        };
        rest = after;
        if let Some(args) = after.strip_prefix('(') {
            for id in string_args(args) {
                out.push((kind, id));
            }
        } else if after.starts_with([' ', '\t']) {
            let word: String = after
                .trim_start()
                .chars()
                .take_while(|c| is_id_char(*c))
                .collect();
            let id = word.trim_end_matches('.');
            if is_valid_id(id) {
                out.push((kind, id.to_string()));
            }
        }
    }
}

/// Reads the quoted ids of a call, from just after `(` up to `)`.
/// Stops at the first thing that is not a string, comma or whitespace.
fn string_args(args: &str) -> Vec<String> {
    let mut ids = Vec::new();
    let mut chars = args.chars().peekable();
    while let Some(&c) = chars.peek() {
        if c == '"' || c == '\'' {
            chars.next();
            let s: String = chars.by_ref().take_while(|&x| x != c).collect();
            if is_valid_id(&s) {
                ids.push(s);
            }
        } else if c == ',' || c.is_whitespace() {
            chars.next();
        } else {
            break;
        }
    }
    ids
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids() {
        assert!(is_valid_id("checkout.failed"));
        assert!(is_valid_id("cart"));
        assert!(is_valid_id("pay.card-declined_2"));
        assert!(!is_valid_id(""));
        assert!(!is_valid_id("Checkout.failed"));
        assert!(!is_valid_id("checkout..failed"));
        assert!(!is_valid_id("checkout."));
        assert!(!is_valid_id("1cart"));
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
        assert!(scan("README.md", "// @spec checkout.failed").is_empty());
    }

    #[test]
    fn invalid_ids_are_ignored() {
        assert!(scan("a.rs", "#[spec(\"Not An Id\")]\nfn f() {}\n").is_empty());
        assert!(scan("a.py", "# @spec Bad.Id\n").is_empty());
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
