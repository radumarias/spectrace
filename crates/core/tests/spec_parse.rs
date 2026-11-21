#![allow(clippy::unwrap_used, clippy::expect_used)]

//! Unit tests of the spec parser: the checkout fixture parses into the expected
//! model, and broken variants of it are rejected with the right code and line.

use spectrace_core::diag::Code::{self, *};
use spectrace_core::spec::{parse, Direction, Parsed};

const CHECKOUT: &str = include_str!("../../../fixtures/shop/spec/checkout.md");
const PROPOSED: &str = include_str!("../../../fixtures/shop/proposed/checkout-with-refunds.md");
const PATH: &str = "spec/checkout.md";

fn diags(p: &Parsed) -> Vec<(usize, Code)> {
    p.diagnostics.iter().map(|d| (d.line, d.code)).collect()
}

/// Parses the checkout fixture with `from` replaced by `to` (exactly once).
fn broken(from: &str, to: &str) -> Parsed {
    assert_eq!(
        CHECKOUT.matches(from).count(),
        1,
        "fixture edit `{from}` is not unique"
    );
    let p = parse(PATH, &CHECKOUT.replacen(from, to, 1));
    for d in &p.diagnostics {
        println!("{d}");
    }
    p
}

/// Asserts that the only errors are exactly `want`, as (line, code).
fn rejects(p: &Parsed, want: &[(usize, Code)]) {
    let errors: Vec<(usize, Code)> = p.errors().map(|d| (d.line, d.code)).collect();
    assert_eq!(errors, want);
    assert!(p.valid().is_none());
}

#[test]
fn parses_the_checkout_fixture() {
    let p = parse(PATH, CHECKOUT);
    assert_eq!(diags(&p), vec![], "{:#?}", p.diagnostics);
    let spec = p.valid().expect("valid");

    assert_eq!(spec.flow, "checkout");
    let title = spec.title.as_ref().expect("title");
    assert_eq!(
        (title.text.as_str(), title.id.as_str(), title.line),
        ("Checkout", "checkout", 1)
    );

    let d = spec.diagram.as_ref().expect("diagram");
    assert_eq!(d.direction, Some(Direction::LR));
    assert_eq!(d.line, 3);
    let nodes: Vec<(&str, &str, usize)> = d
        .nodes
        .iter()
        .map(|n| (n.id.as_str(), n.label.as_str(), n.line))
        .collect();
    assert_eq!(
        nodes,
        vec![
            ("cart", "Cart", 5),
            ("details", "Details", 6),
            ("pay", "Pay", 7),
            ("paid", "Paid", 8),
            ("failed", "Declined", 9),
        ]
    );
    let edges: Vec<(&str, &str, &str, usize)> = d
        .edges
        .iter()
        .map(|e| (e.from.as_str(), e.label.as_str(), e.to.as_str(), e.line))
        .collect();
    assert_eq!(
        edges,
        vec![
            ("cart", "start", "details", 11),
            ("details", "pay", "pay", 12),
            ("pay", "ok", "paid", 13),
            ("pay", "declined", "failed", 14),
            ("failed", "retry", "pay", 15),
        ]
    );
    let clicks: Vec<(&str, &str)> = d
        .clicks
        .iter()
        .map(|c| (c.node.as_str(), c.target.as_str()))
        .collect();
    assert_eq!(clicks[4], ("failed", "checkout.failed"));
    assert_eq!(d.clicks.len(), 5);

    let sections: Vec<(&str, &str, usize, usize)> = spec
        .sections
        .iter()
        .map(|s| {
            (
                s.id.as_str(),
                s.title.as_str(),
                s.line,
                s.requirements.len(),
            )
        })
        .collect();
    assert_eq!(
        sections,
        vec![
            ("checkout.cart", "Cart", 24, 2),
            ("checkout.details", "Details", 31, 2),
            ("checkout.pay", "Pay", 38, 2),
            ("checkout.failed", "Declined payment", 45, 2),
            ("checkout.paid", "Paid", 52, 1),
        ]
    );

    let failed = spec.section("failed").expect("failed section");
    let r2 = &failed.requirements[1];
    assert_eq!(r2.tag, "r2");
    assert_eq!(r2.condition, "a decline goes past the retry limit of 3");
    assert_eq!(r2.response, "cancel the order");
    assert_eq!((r2.line, r2.end_line), (48, 48));
    assert_eq!(r2.id(&failed.id), "checkout.failed/r2");
    let quote = failed.flow.as_ref().expect("@flow quote");
    assert_eq!(
        quote.text,
        "Why a retry limit? Card networks flag repeated retries as card testing."
    );
    assert_eq!(quote.line, 50);

    assert_eq!(
        spec.requirement_ids(),
        vec![
            "checkout.cart/r1",
            "checkout.cart/r2",
            "checkout.details/r1",
            "checkout.details/r2",
            "checkout.pay/r1",
            "checkout.pay/r2",
            "checkout.failed/r1",
            "checkout.failed/r2",
            "checkout.paid/r1",
        ]
    );
}

/// What T5.1's writer relies on: the top-level spans tile the file, and every
/// element's span is exactly its text in the source.
#[test]
fn spans_cover_the_source_byte_for_byte() {
    let p = parse(PATH, CHECKOUT);
    let spec = &p.spec;
    let mut rebuilt = spec.head.slice(CHECKOUT).to_string();
    let mut at = spec.head.end;
    for s in &spec.sections {
        assert_eq!(s.span.start, at, "gap before {}", s.id);
        rebuilt.push_str(s.span.slice(CHECKOUT));
        at = s.span.end;
    }
    assert_eq!(rebuilt, CHECKOUT);

    let d = spec.diagram.as_ref().expect("diagram");
    assert!(d.span.slice(CHECKOUT).starts_with("```mermaid\n"));
    assert!(d.span.slice(CHECKOUT).ends_with("```\n"));
    assert!(d.body.slice(CHECKOUT).starts_with("flowchart LR\n"));
    assert!(d
        .body
        .slice(CHECKOUT)
        .ends_with("\"spec://checkout.failed\"\n"));
    assert_eq!(d.nodes[4].span.slice(CHECKOUT), "  failed[Declined]");
    assert_eq!(
        d.edges[3].span.slice(CHECKOUT),
        "  pay -->|declined| failed"
    );
    assert_eq!(
        d.clicks[0].span.slice(CHECKOUT),
        "  click cart href \"spec://checkout.cart\""
    );
    let paid = spec.section("paid").expect("paid");
    assert_eq!(paid.heading.slice(CHECKOUT), "## Paid {#checkout.paid}");
    assert_eq!(
        paid.requirements[0].span.slice(CHECKOUT),
        "- WHEN payment succeeds THE SYSTEM SHALL email a receipt. {#r1}"
    );
    assert!(paid
        .flow
        .as_ref()
        .expect("quote")
        .span
        .slice(CHECKOUT)
        .starts_with("> @flow The receipt"));
}

#[test]
fn crlf_line_endings_parse_the_same() {
    let crlf = CHECKOUT.replace('\n', "\r\n");
    let a = parse(PATH, CHECKOUT);
    let b = parse(PATH, &crlf);
    assert!(b.diagnostics.is_empty(), "{:#?}", b.diagnostics);
    assert_eq!(a.spec.requirement_ids(), b.spec.requirement_ids());
    let paid = b.spec.section("paid").expect("paid");
    assert_eq!(paid.heading.slice(&crlf), "## Paid {#checkout.paid}");
}

#[test]
fn parses_the_proposed_refund_spec_with_one_long_line_warning() {
    // Parsed as if merged, so the flow id from the file name is `checkout`.
    let p = parse("spec/checkout.md", PROPOSED);
    assert_eq!(diags(&p), vec![(63, W003)]);
    let refunded = p.spec.section("refunded").expect("refunded");
    assert_eq!(
        refunded.requirements[0].condition,
        "a refund is requested within 14 days of payment"
    );
}

#[test]
fn wrapped_requirements_are_joined() {
    let p = broken(
        "- WHEN payment succeeds THE SYSTEM SHALL email a receipt. {#r1}",
        "- WHEN payment succeeds\n  THE SYSTEM SHALL email\n    a receipt. {#r1}",
    );
    assert_eq!(diags(&p), vec![]);
    let r = &p.spec.section("paid").expect("paid").requirements[0];
    assert_eq!(
        (r.condition.as_str(), r.response.as_str()),
        ("payment succeeds", "email a receipt")
    );
    assert_eq!((r.line, r.end_line), (54, 56));
}

#[test]
fn prose_list_items_and_other_code_blocks_are_ignored() {
    let p = broken(
        "> @flow The receipt",
        "- A plain note.\n- When in doubt, read the outbox docs.\n\n```text\n- WHEN broken THE SYSTEM SHALL\n## Not a section\n```\n\n> @flow The receipt",
    );
    assert_eq!(diags(&p), vec![]);
}

// ---- Rejections. The "Done when" asks for five kinds; each error code gets one.

#[test]
fn rejects_title_that_does_not_match_the_file() {
    rejects(
        &broken("# Checkout {#checkout}", "# Checkout {#cart}"),
        &[(1, S001)],
    );
    rejects(
        &broken("# Checkout {#checkout}", "# Checkout"),
        &[(1, S001)],
    );
    rejects(&broken("## Paid {#", "# Paid\n\n## Paid {#"), &[(52, S001)]);
}

#[test]
fn rejects_missing_or_extra_mermaid_block() {
    let no_diagram = {
        let start = CHECKOUT.find("```mermaid").expect("fence");
        let end = CHECKOUT.find("## Cart").expect("section");
        format!("{}{}", &CHECKOUT[..start], &CHECKOUT[end..])
    };
    rejects(&parse(PATH, &no_diagram), &[(1, S002)]);
    rejects(
        &broken(
            "## Paid {#checkout.paid}\n",
            "## Paid {#checkout.paid}\n\n```mermaid\nflowchart LR\n```\n",
        ),
        &[(54, S002)],
    );
}

#[test]
fn rejects_a_diagram_that_is_not_a_flowchart() {
    rejects(&broken("flowchart LR", "graph LR"), &[(4, S003)]);
    rejects(&broken("flowchart LR", "flowchart XY"), &[(4, S003)]);
}

#[test]
fn rejects_mermaid_outside_the_subset() {
    rejects(
        &broken("  cart[Cart]\n", "  cart[Cart]\n  style cart fill:#f00\n"),
        &[(6, S004)],
    );
    // The edges and section of the rejected node are reported too.
    rejects(
        &broken("  paid[Paid]\n", "  paid(Paid)\n"),
        &[(8, S004), (13, S007), (20, S007), (52, S008)],
    );
    rejects(
        &broken(
            "  cart -->|start| details",
            "  cart[Cart] -->|start| details[Details]",
        ),
        &[(11, S004)],
    );
    rejects(
        &broken("  failed -->|retry| pay", "  failed --- pay"),
        &[(15, S004)],
    );
    rejects(
        &broken("  failed -->|retry| pay", "  failed -- retry --> pay"),
        &[(15, S004)],
    );
    rejects(
        &broken(
            "  failed -->|retry| pay",
            "  failed -->|retry| pay -->|ok| paid",
        ),
        &[(15, S004)],
    );
}

#[test]
fn rejects_an_edge_without_a_label() {
    rejects(
        &broken("  pay -->|ok| paid", "  pay --> paid"),
        &[(13, S005)],
    );
    rejects(
        &broken("  pay -->|ok| paid", "  pay -->| | paid"),
        &[(13, S005)],
    );
}

#[test]
fn rejects_bad_ids_and_duplicate_nodes() {
    rejects(
        &broken("  pay[Pay]\n", "  pay[Pay]\n  pay[Pay again]\n"),
        &[(8, S006)],
    );
    rejects(
        &broken("## Paid {#checkout.paid}", "## Paid {#checkout.Paid}"),
        &[(8, S008), (52, S006)],
    );
}

#[test]
fn rejects_an_edge_to_an_undeclared_node() {
    rejects(
        &broken("  failed -->|retry| pay", "  failed -->|refund| refunded"),
        &[(15, S007)],
    );
    rejects(
        &broken("  click paid href", "  click gone href"),
        &[(20, S007), (20, S013)],
    );
}

#[test]
fn rejects_a_node_without_a_section_and_a_section_without_a_node() {
    let start = CHECKOUT.find("## Paid").expect("paid");
    rejects(&parse(PATH, &CHECKOUT[..start]), &[(8, S008)]);
    rejects(
        &broken(
            "## Paid {#checkout.paid}",
            "## Paid {#checkout.paid}\n\n## Lost {#checkout.lost}\n",
        ),
        &[(54, S008)],
    );
}

#[test]
fn rejects_a_repeated_or_foreign_section() {
    rejects(
        &broken("## Paid {#checkout.paid}", "## Again {#checkout.cart}\n\n- WHEN x THE SYSTEM SHALL y. {#r1}\n\n## Paid {#checkout.paid}"),
        &[(52, S009)],
    );
    rejects(
        &broken("## Paid {#checkout.paid}", "## Paid {#cart.paid}"),
        &[(8, S008), (52, S009)],
    );
}

#[test]
fn rejects_a_requirement_that_does_not_parse() {
    let line = "- WHEN payment succeeds THE SYSTEM SHALL email a receipt. {#r1}";
    for bad in [
        "- WHEN payment succeeds THE SYSTEM SHALL email a receipt.",
        "- WHEN payment succeeds THE SYSTEM SHALL email a receipt {#r1}",
        "- WHEN payment succeeds THE SYSTEM SHALL email a receipt. {#r1} and log it.",
        "- WHEN payment succeeds email a receipt. {#r1}",
        "- WHEN payment succeeds THE SYSTEM SHALL email a receipt THE SYSTEM SHALL log it. {#r1}",
        "- WHEN payment succeeds THE SYSTEM SHALL email a receipt WHEN asked. {#r1}",
        "- When payment succeeds THE SYSTEM SHALL email a receipt. {#r1}",
        "* WHEN payment succeeds THE SYSTEM SHALL email a receipt. {#r1}",
        "  - WHEN payment succeeds THE SYSTEM SHALL email a receipt. {#r1}",
    ] {
        let p = broken(line, bad);
        assert_eq!(diags(&p), vec![(52, W001), (54, S010)], "{bad}");
        assert!(p.valid().is_none());
    }
    rejects(
        &broken(
            "## Cart {#",
            "- WHEN early THE SYSTEM SHALL fail. {#r1}\n\n## Cart {#",
        ),
        &[(24, S010)],
    );
}

#[test]
fn rejects_repeated_and_malformed_tags() {
    rejects(
        &broken("keep the rest. {#r2}", "keep the rest. {#r1}"),
        &[(27, S011)],
    );
    rejects(
        &broken("keep the rest. {#r2}", "keep the rest. {#r0}"),
        &[(27, S011)],
    );
    rejects(
        &broken("keep the rest. {#r2}", "keep the rest. {#checkout.cart/r2}"),
        &[(27, S011)],
    );
}

#[test]
fn rejects_two_flow_quotes_in_a_section() {
    rejects(
        &broken(
            "> @flow The receipt",
            "> @flow One reason.\n\n> @flow The receipt",
        ),
        &[(58, S012)],
    );
}

#[test]
fn rejects_a_click_to_the_wrong_step() {
    rejects(
        &broken(
            "click paid href \"spec://checkout.paid\"",
            "click paid href \"spec://checkout.pay\"",
        ),
        &[(20, S013)],
    );
}

#[test]
fn rejects_a_duplicate_edge() {
    rejects(
        &broken(
            "  pay -->|ok| paid\n",
            "  pay -->|ok| paid\n  pay -->|ok| paid\n",
        ),
        &[(14, S014)],
    );
}

#[test]
fn warns_without_blocking() {
    let p = broken(
        "- WHEN payment succeeds THE SYSTEM SHALL email a receipt. {#r1}",
        "- WHEN payment succeeds and the order has been written to the outbox table THE SYSTEM SHALL email a receipt. {#r1}",
    );
    assert_eq!(diags(&p), vec![(54, W003)]);
    assert!(p.valid().is_some());

    let p = broken("  paid[Paid]\n", "  paid[Paid]\n  lonely[Lonely]\n");
    let p2 = {
        let src = format!(
            "{}\n## Lonely {{#checkout.lonely}}\n\nNothing yet.\n",
            CHECKOUT.replacen("  paid[Paid]\n", "  paid[Paid]\n  lonely[Lonely]\n", 1)
        );
        parse(PATH, &src)
    };
    assert_eq!(diags(&p), vec![(9, S008), (9, W002)]);
    assert_eq!(diags(&p2), vec![(9, W002), (59, W001)]);
    assert!(p2.valid().is_some());
}

#[test]
fn diagnostics_name_file_line_and_code() {
    let p = broken("  pay -->|ok| paid", "  pay --> paid");
    assert_eq!(
        p.errors()
            .next()
            .map(ToString::to_string)
            .unwrap_or_default(),
        "spec/checkout.md:13: error S005: edge has no label, write `a -->|label| b`"
    );
}
