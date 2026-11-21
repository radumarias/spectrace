//! Unit tests of the anchor scanner on a fixture file for each language.
//! Fixtures carry a `.txt` suffix so no tool mistakes them for real source.

use spectrace_core::anchor::{scan, AnchorClass::*, AnchorKind::*, Language};

const RUST: &str = include_str!("fixtures/anchors/checkout.rs.txt");
const TYPESCRIPT: &str = include_str!("fixtures/anchors/checkout.ts.txt");
const PYTHON: &str = include_str!("fixtures/anchors/checkout.py.txt");

type Row = (
    usize,
    spectrace_core::anchor::AnchorKind,
    &'static str,
    spectrace_core::anchor::AnchorClass,
);

fn rows(
    path: &str,
    source: &str,
) -> Vec<(
    usize,
    spectrace_core::anchor::AnchorKind,
    String,
    spectrace_core::anchor::AnchorClass,
)> {
    scan(path, source)
        .into_iter()
        .map(|a| (a.line, a.kind, a.id, a.class))
        .collect()
}

fn check(path: &str, source: &str, want: &[Row]) {
    let want: Vec<_> = want
        .iter()
        .map(|(l, k, i, c)| (*l, *k, i.to_string(), *c))
        .collect();
    assert_eq!(rows(path, source), want);
}

#[test]
fn rust_anchors() {
    check(
        "crates/server/src/checkout.rs",
        RUST,
        &[
            (3, Flow, "checkout.pay", Code),
            (5, Spec, "checkout.paid", Code),
            (7, Flow, "checkout.failed", Code),
            (11, Spec, "checkout.failed", Code),
            (11, Spec, "checkout.refunded", Code),
            (21, Spec, "checkout.paid", Test),
            (25, Spec, "checkout.failed", Test),
            (29, Spec, "cart.add", Test),
            (33, Spec, "cart.remove", Code),
        ],
    );
}

#[test]
fn typescript_anchors() {
    check(
        "web/src/checkout.ts",
        TYPESCRIPT,
        &[
            (1, Flow, "checkout.pay", Code),
            (3, Spec, "checkout.paid", Code),
            (7, Spec, "checkout.failed", Code),
            (11, Spec, "checkout.refunded", Code),
            (15, Spec, "checkout.paid", Test),
            (17, Spec, "checkout.failed", Test),
            (21, Spec, "cart.add", Test),
        ],
    );
}

#[test]
fn python_anchors() {
    check(
        "app/checkout.py",
        PYTHON,
        &[
            (1, Flow, "checkout.pay", Code),
            (3, Spec, "checkout.paid", Code),
            (7, Spec, "checkout.failed", Code),
            (12, Spec, "checkout.refunded", Code),
            (12, Spec, "cart.remove", Code),
            (17, Spec, "checkout.paid", Test),
            (23, Flow, "checkout.failed", Test),
            (28, Spec, "cart.add", Test),
            (34, Spec, "cart.after", Code),
        ],
    );
}

#[test]
fn test_path_makes_everything_a_test() {
    let all_test = |path: &str, src: &str| scan(path, src).iter().all(|a| a.class == Test);
    assert!(all_test("crates/server/tests/checkout.rs", RUST));
    assert!(all_test("web/src/checkout.test.ts", TYPESCRIPT));
    assert!(all_test("app/test_checkout.py", PYTHON));
}

#[test]
fn language_is_reported() {
    assert!(scan("a.rs", RUST)
        .iter()
        .all(|a| a.language == Language::Rust));
    assert!(scan("a.tsx", TYPESCRIPT)
        .iter()
        .all(|a| a.language == Language::TypeScript));
    assert!(scan("a.py", PYTHON)
        .iter()
        .all(|a| a.language == Language::Python));
}
