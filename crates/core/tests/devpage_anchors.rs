#![allow(clippy::unwrap_used, clippy::expect_used)]

//! spectrace and devpage read the same `#[spec]` anchors (issue #91).
//!
//! devpage's requirements check finds a test's constraint with a regular
//! expression over every file of a suite's glob, and counts each match as a
//! test pointing at a constraint. This test applies the fixture's suite
//! (`fixtures/shop/devpage-requirements.yml`) the way devpage does and checks
//! it finds exactly the coverage anchors spectrace's scanner finds, each a
//! requirement id, and no implementation anchor.

use regex::Regex;
use spectrace_core::anchor::{is_valid_req_id, scan, AnchorClass, AnchorKind};

const SUITE: &str = include_str!("../../../fixtures/shop/devpage-requirements.yml");

/// Files of the fixture, by path relative to `fixtures/shop`.
const FILES: &[(&str, &str)] = &[
    (
        "src/cart.rs",
        include_str!("../../../fixtures/shop/src/cart.rs"),
    ),
    (
        "src/checkout.rs",
        include_str!("../../../fixtures/shop/src/checkout.rs"),
    ),
    (
        "tests/checkout.rs",
        include_str!("../../../fixtures/shop/tests/checkout.rs"),
    ),
];

/// The value of `key:` in the suite file, unquoted. The file is ours and flat
/// enough that a YAML parser would add a dependency for nothing.
fn field(key: &str) -> String {
    let line = SUITE
        .lines()
        .map(str::trim_start)
        .map(|l| l.trim_start_matches("- "))
        .find_map(|l| l.strip_prefix(&format!("{key}:")))
        .unwrap_or_else(|| panic!("suite has no {key}"));
    let v = line.trim();
    match (v.chars().next(), v.chars().last()) {
        (Some('\''), Some('\'')) | (Some('"'), Some('"')) => v[1..v.len() - 1].to_string(),
        _ => v.to_string(),
    }
}

/// Whether `path` is under the suite's glob. Only the `dir/**/*.rs` shape is
/// supported, which is the one the docs recommend.
fn in_glob(glob: &str, path: &str) -> bool {
    let (dir, rest) = glob
        .split_once("/**/")
        .unwrap_or_else(|| panic!("glob {glob} is not dir/**/*.ext"));
    let ext = rest
        .strip_prefix('*')
        .unwrap_or_else(|| panic!("glob {glob} is not dir/**/*.ext"));
    path.starts_with(&format!("{dir}/")) && path.ends_with(ext)
}

/// (file, line, id) for every match devpage would count as a test pointer.
fn devpage_pointers() -> Vec<(String, usize, String)> {
    let glob = field("glob");
    let pattern = Regex::new(&field("pattern")).unwrap();
    let mut out = Vec::new();
    for (path, source) in FILES.iter().filter(|(p, _)| in_glob(&glob, p)) {
        for c in pattern.captures_iter(source) {
            let m = c.get(1).unwrap();
            let line = source[..m.start()].matches('\n').count() + 1;
            out.push((path.to_string(), line, m.as_str().to_string()));
        }
    }
    out
}

/// (file, line, id) for every spectrace anchor of the given class.
fn spectrace_anchors(class: AnchorClass) -> Vec<(String, usize, String)> {
    FILES
        .iter()
        .flat_map(|(path, source)| {
            scan(path, source)
                .into_iter()
                .filter(move |a| a.kind == AnchorKind::Spec && a.class == class)
                .map(move |a| (path.to_string(), a.line, a.id))
        })
        .collect()
}

#[test]
fn devpage_finds_the_coverage_anchors_spectrace_finds() {
    let devpage = devpage_pointers();
    assert!(!devpage.is_empty(), "the suite found no anchors");
    assert_eq!(devpage, spectrace_anchors(AnchorClass::Test));
}

#[test]
fn devpage_counts_no_implementation_anchor_as_a_test() {
    let devpage = devpage_pointers();
    let code = spectrace_anchors(AnchorClass::Code);
    assert!(!code.is_empty(), "the fixture has implementation anchors");
    for anchor in &code {
        assert!(
            !devpage.contains(anchor),
            "devpage would count {anchor:?} as a test"
        );
    }
}

#[test]
fn every_test_anchor_names_a_requirement() {
    // devpage's constraints are requirements; a test naming a step id would
    // be reported there as "no constraint has this id".
    for (path, line, id) in devpage_pointers() {
        assert!(
            is_valid_req_id(&id),
            "{path}:{line}: {id} is not a requirement id"
        );
    }
}

#[test]
fn the_pattern_reads_one_id_per_attribute() {
    // Why the spec format asks for one id per #[spec]: devpage takes only the
    // first group of each match, so a second argument is invisible to it.
    let pattern = Regex::new(&field("pattern")).unwrap();
    let ids =
        |s: &str| -> Vec<String> { pattern.captures_iter(s).map(|c| c[1].to_string()).collect() };
    assert_eq!(
        ids("#[test]\n#[spec(\"a.b/r1\")]\n#[spec(\"a.b/r2\")]\nfn t() {}"),
        ["a.b/r1", "a.b/r2"]
    );
    assert!(ids("#[spec(\"a.b/r1\", \"a.b/r2\")]").is_empty());
}
