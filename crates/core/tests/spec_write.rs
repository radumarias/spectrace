#![allow(clippy::unwrap_used, clippy::expect_used)]

//! Tests of the spec writer (T5.1): untouched specs come back byte for byte,
//! every edit the diagram editor makes reads back as the edited model, and the
//! diff of each edit is only the lines it changes.

use spectrace_core::spec::{parse, Direction, FlowQuote, Spec};
use spectrace_core::write::{write, WriteError};

const CHECKOUT: &str = include_str!("../../../fixtures/shop/spec/checkout.md");
const PROPOSED: &str = include_str!("../../../fixtures/shop/proposed/checkout-with-refunds.md");
const PATH: &str = "spec/checkout.md";

fn model(src: &str) -> Spec {
    let p = parse(PATH, src);
    assert!(!p.has_errors(), "{:#?}", p.diagnostics);
    p.spec
}

/// Parses `src`, applies `change` to a copy of the model, writes it and checks
/// that the output parses back into the edited model with no errors.
fn edit(src: &str, change: impl FnOnce(&mut Spec, &Spec)) -> String {
    let original = model(src);
    let mut edited = original.clone();
    change(&mut edited, &original);
    let out = write(src, &original, &edited).unwrap_or_else(|e| panic!("{e}\n"));
    let reread = model(&out);
    // Same model, read back. `write` checks this too; this keeps the test honest.
    assert_eq!(content(&reread), content(&edited), "output:\n{out}");
    // And writing the read-back model untouched is the identity.
    assert_eq!(write(&out, &reread, &reread).unwrap(), out);
    out
}

/// A model without positions, for comparing what two specs say.
fn content(s: &Spec) -> String {
    let d = s.diagram.as_ref().expect("diagram");
    let mut out = format!(
        "{:?} {:?}\n",
        s.title.as_ref().map(|t| (&t.text, &t.id)),
        d.direction
    );
    let mut nodes: Vec<_> = d.nodes.iter().map(|n| (&n.id, &n.label)).collect();
    nodes.sort();
    let mut edges: Vec<_> = d.edges.iter().map(|e| (&e.from, &e.label, &e.to)).collect();
    edges.sort();
    let mut clicks: Vec<_> = d.clicks.iter().map(|c| (&c.node, &c.target)).collect();
    clicks.sort();
    let mut sections: Vec<_> = s
        .sections
        .iter()
        .map(|s| {
            let mut reqs: Vec<_> = s
                .requirements
                .iter()
                .map(|r| (&r.tag, &r.condition, &r.response))
                .collect();
            reqs.sort();
            format!(
                "{} {:?} {:?} {:?}",
                s.id,
                s.title,
                reqs,
                s.flow.as_ref().map(|q| &q.text)
            )
        })
        .collect();
    sections.sort();
    out.push_str(&format!("{nodes:?}\n{edges:?}\n{clicks:?}\n"));
    for s in sections {
        out.push_str(&s);
        out.push('\n');
    }
    out
}

/// The lines removed from `a` and added in `b`, by a line LCS diff.
fn diff(a: &str, b: &str) -> (Vec<String>, Vec<String>) {
    let a: Vec<&str> = a.split_inclusive('\n').collect();
    let b: Vec<&str> = b.split_inclusive('\n').collect();
    let mut lcs = vec![vec![0usize; b.len() + 1]; a.len() + 1];
    for i in (0..a.len()).rev() {
        for j in (0..b.len()).rev() {
            lcs[i][j] = if a[i] == b[j] {
                lcs[i + 1][j + 1] + 1
            } else {
                lcs[i + 1][j].max(lcs[i][j + 1])
            };
        }
    }
    let (mut i, mut j) = (0, 0);
    let (mut removed, mut added) = (Vec::new(), Vec::new());
    while i < a.len() || j < b.len() {
        if i < a.len() && j < b.len() && a[i] == b[j] {
            i += 1;
            j += 1;
        } else if j < b.len() && (i == a.len() || lcs[i][j + 1] >= lcs[i + 1][j]) {
            added.push(b[j].trim_end_matches(['\n', '\r']).to_string());
            j += 1;
        } else {
            removed.push(a[i].trim_end_matches(['\n', '\r']).to_string());
            i += 1;
        }
    }
    (removed, added)
}

fn lines(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

// ---- Untouched files.

#[test]
fn untouched_fixture_files_are_byte_identical() {
    for src in [CHECKOUT, PROPOSED] {
        let spec = model(src);
        assert_eq!(write(src, &spec, &spec).unwrap(), src);
    }
}

#[test]
fn untouched_files_with_crlf_wrapping_and_prose_are_byte_identical() {
    let odd = CHECKOUT
        .replace(
            "- WHEN payment succeeds THE SYSTEM SHALL email a receipt. {#r1}",
            "- WHEN payment succeeds\n  THE SYSTEM SHALL email\n    a receipt. {#r1}",
        )
        .replace(
            "# Checkout {#checkout}\n",
            "# Checkout {#checkout}\n\nSome prose about the flow.\n",
        )
        .replace("  cart[Cart]\n", "  %% the entry point\n  cart[Cart]\n")
        .replace(
            "> @flow The receipt",
            "A note in the section.\n\n> @flow The receipt",
        );
    for src in [
        odd.clone(),
        odd.replace('\n', "\r\n"),
        CHECKOUT.replace('\n', "\r\n"),
    ] {
        let spec = model(&src);
        assert_eq!(write(&src, &spec, &spec).unwrap(), src);
    }
}

#[test]
fn parse_write_parse_gives_the_same_model() {
    for src in [CHECKOUT, PROPOSED] {
        let spec = model(src);
        let out = write(src, &spec, &spec).unwrap();
        assert_eq!(parse(PATH, &out), parse(PATH, src));
    }
}

// ---- Renames.

#[test]
fn renaming_a_node_label_changes_one_line() {
    let out = edit(CHECKOUT, |s, _| {
        let d = s.diagram.as_mut().unwrap();
        d.node_mut("failed").unwrap().label = "Card declined".into();
    });
    assert_eq!(
        diff(CHECKOUT, &out),
        (
            lines(&["  failed[Declined]"]),
            lines(&["  failed[Card declined]"])
        )
    );
}

#[test]
fn renaming_a_section_and_the_title_changes_only_their_lines() {
    let out = edit(CHECKOUT, |s, _| {
        s.title.as_mut().unwrap().text = "Checkout flow".into();
        s.section_mut("failed").unwrap().title = "Payment declined".into();
    });
    assert_eq!(
        diff(CHECKOUT, &out),
        (
            lines(&[
                "# Checkout {#checkout}",
                "## Declined payment {#checkout.failed}"
            ]),
            lines(&[
                "# Checkout flow {#checkout}",
                "## Payment declined {#checkout.failed}"
            ])
        )
    );
}

#[test]
fn changing_the_direction_changes_the_header_line() {
    let out = edit(CHECKOUT, |s, _| {
        s.diagram.as_mut().unwrap().direction = Some(Direction::TD);
    });
    assert_eq!(
        diff(CHECKOUT, &out),
        (lines(&["flowchart LR"]), lines(&["flowchart TD"]))
    );
}

// ---- Steps.

#[test]
fn adding_the_refund_step_gives_the_proposed_spec() {
    let out = edit(CHECKOUT, |s, _| {
        assert!(s.add_step("refunded", "Refunded", "Refund"));
        assert!(s.add_edge("paid", "refund", "refunded"));
        let sec = s.section_mut("refunded").unwrap();
        assert_eq!(
            sec.add_requirement(
                "a refund is requested within 14 days of payment",
                "refund the full amount",
                None
            ),
            "r1"
        );
        sec.add_requirement("a refund completes", "return the stock", None);
        sec.flow = Some(FlowQuote {
            text: "Refund through the original charge so the card network links the two.".into(),
            line: 0,
            end_line: 0,
            span: Default::default(),
        });
    });
    // The proposed file has its long r1 on one line (a W003 warning); the
    // writer wraps lines over 100 characters, so that is the only difference.
    let wrapped = PROPOSED.replace(
        "refund the full amount. {#r1}",
        "refund the full\n  amount. {#r1}",
    );
    assert_eq!(out, wrapped);
    assert_eq!(content(&model(&out)), content(&model(PROPOSED)));
    let p = parse(PATH, &out);
    assert!(p.diagnostics.is_empty(), "{:#?}", p.diagnostics);
}

#[test]
fn deleting_a_step_removes_its_node_edges_click_and_section() {
    let out = edit(CHECKOUT, |s, _| {
        assert!(s.remove_step("failed"));
    });
    let (removed, added) = diff(CHECKOUT, &out);
    assert_eq!(added, Vec::<String>::new());
    assert_eq!(
        removed,
        lines(&[
            "  failed[Declined]",
            "  pay -->|declined| failed",
            "  failed -->|retry| pay",
            "  click failed href \"spec://checkout.failed\"",
            "## Declined payment {#checkout.failed}",
            "",
            "- WHEN a payment is declined THE SYSTEM SHALL show the reason. {#r1}",
            "- WHEN a decline goes past the retry limit of 3 THE SYSTEM SHALL cancel the order. {#r2}",
            "",
            "> @flow Why a retry limit? Card networks flag repeated retries as card testing.",
            "",
        ])
    );
}

#[test]
fn deleting_the_last_section_leaves_one_final_newline() {
    let out = edit(CHECKOUT, |s, _| {
        assert!(s.remove_step("paid"));
    });
    assert!(out.ends_with("as card testing.\n"), "{out}");
    let (_, added) = diff(CHECKOUT, &out);
    assert_eq!(added, Vec::<String>::new());
}

#[test]
fn adding_a_step_to_a_diagram_without_clicks_adds_no_click() {
    let src: String = CHECKOUT
        .lines()
        .filter(|l| !l.trim_start().starts_with("click "))
        .map(|l| format!("{l}\n"))
        .collect();
    let out = edit(&src, |s, _| {
        assert!(s.add_step("refunded", "Refunded", "Refund"));
        assert!(s.add_edge("paid", "refund", "refunded"));
        s.section_mut("refunded").unwrap().add_requirement(
            "a refund completes",
            "return the stock",
            None,
        );
    });
    assert!(!out.contains("click"));
    let (removed, added) = diff(&src, &out);
    assert!(removed.is_empty(), "{removed:?}");
    assert_eq!(
        added,
        lines(&[
            "  refunded[Refunded]",
            "  paid -->|refund| refunded",
            "",
            "## Refund {#checkout.refunded}",
            "",
            "- WHEN a refund completes THE SYSTEM SHALL return the stock. {#r1}",
        ])
    );
}

// ---- Arrows.

#[test]
fn adding_an_edge_appends_one_line_to_the_edges() {
    let out = edit(CHECKOUT, |s, _| {
        assert!(s.add_edge("failed", "give up", "cart"));
    });
    assert_eq!(
        diff(CHECKOUT, &out),
        (vec![], lines(&["  failed -->|give up| cart"]))
    );
    assert!(out.contains("  failed -->|retry| pay\n  failed -->|give up| cart\n\n  click"));
}

#[test]
fn deleting_an_edge_removes_one_line() {
    let out = edit(CHECKOUT, |s, _| {
        assert!(s.remove_edge("failed", "retry", "pay"));
    });
    assert_eq!(
        diff(CHECKOUT, &out),
        (lines(&["  failed -->|retry| pay"]), vec![])
    );
}

#[test]
fn relabelling_and_retargeting_an_edge_rewrites_it_in_place() {
    let out = edit(CHECKOUT, |s, _| {
        let d = s.diagram.as_mut().unwrap();
        let e = d.edges.iter_mut().find(|e| e.label == "retry").unwrap();
        e.label = "try again".into();
        e.to = "details".into();
    });
    assert_eq!(
        diff(CHECKOUT, &out),
        (
            lines(&["  failed -->|retry| pay"]),
            lines(&["  failed -->|try again| details"])
        )
    );
}

#[test]
fn adding_edges_to_a_diagram_without_edges_starts_a_group() {
    let src = CHECKOUT.replace("  cart -->|start| details\n  details -->|pay| pay\n  pay -->|ok| paid\n  pay -->|declined| failed\n  failed -->|retry| pay\n\n", "");
    let out = edit(&src, |s, _| {
        assert!(s.add_edge("cart", "start", "details"));
    });
    assert!(
        out.contains("  failed[Declined]\n\n  cart -->|start| details\n\n  click cart"),
        "{out}"
    );
}

// ---- Requirement lines.

#[test]
fn editing_a_requirement_changes_one_line() {
    let out = edit(CHECKOUT, |s, _| {
        let r = s
            .section_mut("failed")
            .unwrap()
            .requirement_mut("r2")
            .unwrap();
        r.condition = "a decline goes past the retry limit of 5".into();
    });
    assert_eq!(
        diff(CHECKOUT, &out),
        (
            lines(&["- WHEN a decline goes past the retry limit of 3 THE SYSTEM SHALL cancel the order. {#r2}"]),
            lines(&["- WHEN a decline goes past the retry limit of 5 THE SYSTEM SHALL cancel the order. {#r2}"])
        )
    );
}

#[test]
fn adding_a_requirement_uses_the_next_tag_after_the_last_one() {
    let out = edit(CHECKOUT, |s, _| {
        let sec = s.section_mut("paid").unwrap();
        let tag = sec.add_requirement("the receipt bounces", "show it on the order page", None);
        assert_eq!(tag, "r2");
    });
    assert_eq!(
        diff(CHECKOUT, &out),
        (
            vec![],
            lines(&[
                "- WHEN the receipt bounces THE SYSTEM SHALL show it on the order page. {#r2}"
            ])
        )
    );
    assert!(out.contains("receipt. {#r1}\n- WHEN the receipt bounces"));
}

#[test]
fn deleting_a_requirement_removes_its_line_and_retires_its_tag() {
    let out = edit(CHECKOUT, |s, original| {
        let sec = s.section_mut("failed").unwrap();
        sec.requirements.retain(|r| r.tag != "r2");
        // r2 is retired: a requirement added in the same edit gets r3.
        let tag = sec.add_requirement(
            "the user gives up",
            "keep the cart",
            original.section("failed"),
        );
        assert_eq!(tag, "r3");
    });
    assert_eq!(
        diff(CHECKOUT, &out),
        (
            lines(&["- WHEN a decline goes past the retry limit of 3 THE SYSTEM SHALL cancel the order. {#r2}"]),
            lines(&["- WHEN the user gives up THE SYSTEM SHALL keep the cart. {#r3}"])
        )
    );
}

#[test]
fn deleting_every_requirement_keeps_the_blank_lines_tidy() {
    let out = edit(CHECKOUT, |s, _| {
        s.section_mut("cart").unwrap().requirements.clear();
    });
    assert!(
        out.contains("## Cart {#checkout.cart}\n\n> @flow Stock"),
        "{out}"
    );
    // And replacing them all puts the new ones where the old ones were.
    let out = edit(CHECKOUT, |s, o| {
        let sec = s.section_mut("cart").unwrap();
        sec.requirements.clear();
        sec.add_requirement("the cart loads", "show the total", o.section("cart"));
    });
    assert!(
        out.contains(
            "## Cart {#checkout.cart}\n\n- WHEN the cart loads THE SYSTEM SHALL show the total. {#r3}\n\n> @flow Stock"
        ),
        "{out}"
    );
}

#[test]
fn a_long_requirement_is_wrapped_and_reads_back_joined() {
    let response = "show the reason, the card's last four digits, a link to try another card and a link to contact support";
    let out = edit(CHECKOUT, |s, _| {
        let r = s
            .section_mut("failed")
            .unwrap()
            .requirement_mut("r1")
            .unwrap();
        r.response = response.into();
    });
    let (removed, added) = diff(CHECKOUT, &out);
    assert_eq!(removed.len(), 1);
    assert!(added.len() >= 2, "{added:?}");
    assert!(added.iter().all(|l| l.chars().count() <= 100), "{added:?}");
    assert!(added[1..].iter().all(|l| l.starts_with("  ")));
    let reread = model(&out);
    let r = &reread.section("failed").unwrap().requirements[0];
    assert_eq!(r.response, response);
    assert!(parse(PATH, &out).diagnostics.is_empty());
}

// ---- `@flow` quotes.

#[test]
fn editing_removing_and_adding_a_flow_quote() {
    let out = edit(CHECKOUT, |s, _| {
        s.section_mut("pay").unwrap().flow.as_mut().unwrap().text =
            "One idempotency key per order.".into();
    });
    assert_eq!(
        diff(CHECKOUT, &out),
        (
            lines(&[
                "> @flow An idempotency key per order stops a gateway timeout from charging twice."
            ]),
            lines(&["> @flow One idempotency key per order."])
        )
    );

    let out = edit(CHECKOUT, |s, _| {
        s.section_mut("pay").unwrap().flow = None;
    });
    assert_eq!(
        diff(CHECKOUT, &out),
        (
            lines(&[
                "> @flow An idempotency key per order stops a gateway timeout from charging twice.",
                ""
            ]),
            vec![]
        )
    );

    let without = edit(CHECKOUT, |s, _| {
        s.section_mut("pay").unwrap().flow = None;
    });
    let back = edit(&without, |s, _| {
        s.section_mut("pay").unwrap().flow = Some(FlowQuote {
            text: "An idempotency key per order stops a gateway timeout from charging twice."
                .into(),
            line: 0,
            end_line: 0,
            span: Default::default(),
        });
    });
    assert_eq!(back, CHECKOUT);
}

// ---- Several edits at once, and line endings.

#[test]
fn many_edits_at_once_touch_only_their_lines() {
    let out = edit(CHECKOUT, |s, o| {
        s.diagram
            .as_mut()
            .unwrap()
            .node_mut("details")
            .unwrap()
            .label = "Address".into();
        assert!(s.remove_edge("pay", "ok", "paid"));
        assert!(s.add_edge("pay", "charged", "paid"));
        let cart = s.section_mut("cart").unwrap();
        cart.requirements.retain(|r| r.tag != "r1");
        cart.add_requirement(
            "the cart is saved",
            "keep it for 30 days",
            o.section("cart"),
        );
        s.section_mut("paid").unwrap().title = "Payment received".into();
    });
    let (removed, added) = diff(CHECKOUT, &out);
    assert_eq!(removed.len(), 4, "{removed:?}");
    assert_eq!(added.len(), 4, "{added:?}");
}

#[test]
fn crlf_files_get_crlf_lines() {
    let src = CHECKOUT.replace('\n', "\r\n");
    let out = edit(&src, |s, _| {
        assert!(s.add_step("refunded", "Refunded", "Refund"));
        assert!(s.add_edge("paid", "refund", "refunded"));
        s.section_mut("refunded").unwrap().add_requirement(
            "a refund completes",
            "return the stock",
            None,
        );
    });
    assert!(
        !out.replace("\r\n", "").contains('\n'),
        "a bare \\n was written"
    );
    assert_eq!(
        out.replace("\r\n", "\n"),
        edit(CHECKOUT, |s, _| {
            s.add_step("refunded", "Refunded", "Refund");
            s.add_edge("paid", "refund", "refunded");
            s.section_mut("refunded").unwrap().add_requirement(
                "a refund completes",
                "return the stock",
                None,
            );
        })
    );
}

// ---- Refusals.

#[test]
fn refuses_output_that_would_not_parse() {
    let original = model(CHECKOUT);

    let mut bad_label = original.clone();
    bad_label
        .diagram
        .as_mut()
        .unwrap()
        .node_mut("cart")
        .unwrap()
        .label = "Cart [beta]".into();
    assert!(matches!(
        write(CHECKOUT, &original, &bad_label),
        Err(WriteError::Invalid(_))
    ));

    // A node with no section is an S008 error.
    let mut orphan = original.clone();
    let d = orphan.diagram.as_mut().unwrap();
    d.nodes.push(spectrace_core::spec::Node {
        id: "lost".into(),
        label: "Lost".into(),
        line: 0,
        span: Default::default(),
    });
    assert!(matches!(
        write(CHECKOUT, &original, &orphan),
        Err(WriteError::Invalid(_))
    ));

    let mut renamed_flow = original.clone();
    renamed_flow.flow = "basket".into();
    assert!(matches!(
        write(CHECKOUT, &original, &renamed_flow),
        Err(WriteError::Unsupported(_))
    ));
}

#[test]
fn refuses_text_that_would_read_back_differently() {
    let original = model(CHECKOUT);
    let mut edited = original.clone();
    edited
        .section_mut("pay")
        .unwrap()
        .flow
        .as_mut()
        .unwrap()
        .text = "first line\nsecond line".into();
    let err = write(CHECKOUT, &original, &edited).unwrap_err();
    assert!(
        matches!(err, WriteError::Mismatch(_) | WriteError::Invalid(_)),
        "{err}"
    );
}
