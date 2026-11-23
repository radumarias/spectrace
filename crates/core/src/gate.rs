//! Merge gates: the checks a pull request must pass before spectrace merges it.
//!
//! The Worker gathers the facts of a pull request into a [`GateInput`], calls
//! [`evaluate`], shows the result on the PR page, and refuses a merge while
//! [`blocking`] names a gate. Pure rules, no I/O.

/// What is known about a pull request's head commit.
#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(
    feature = "serde",
    derive(serde::Deserialize),
    serde(rename_all = "camelCase")
)]
pub struct GateInput {
    /// An agent review of the head commit has finished.
    pub review_finished: bool,
    /// Findings of that review, not refuted and not dealt with, of severity high or medium.
    pub open_serious_findings: u32,
    /// Latest check run of each name on the head commit.
    pub checks_total: u32,
    pub checks_failed: u32,
    /// Not completed yet (queued or running).
    pub checks_pending: u32,
    /// Approvals of the head commit.
    pub approvals: u32,
    /// Critical repositories need two approvals instead of one.
    pub critical: bool,
    /// Every changed file maps to a spec. `None` while mapping is not available.
    pub files_mapped: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(
    feature = "serde",
    derive(serde::Serialize),
    serde(rename_all = "snake_case")
)]
pub enum GateStatus {
    Pass,
    /// Must be fixed before merging.
    Open,
    /// Not known yet; does not hold the merge back.
    Unchecked,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
pub struct Gate {
    /// Stable name: `review`, `findings`, `mapping`, `tests` or `approval`.
    pub id: &'static str,
    pub label: String,
    pub status: GateStatus,
}

/// Approvals a pull request needs.
pub fn required_approvals(critical: bool) -> u32 {
    if critical {
        2
    } else {
        1
    }
}

fn gate(id: &'static str, label: impl Into<String>, status: GateStatus) -> Gate {
    Gate {
        id,
        label: label.into(),
        status,
    }
}

fn pass_if(ok: bool) -> GateStatus {
    if ok {
        GateStatus::Pass
    } else {
        GateStatus::Open
    }
}

/// All gates, in the order the page lists them.
pub fn evaluate(input: &GateInput) -> Vec<Gate> {
    let need = required_approvals(input.critical);
    let approvals = if input.critical {
        format!(
            "Two owner approvals (critical) · {}/{need}",
            input.approvals.min(need)
        )
    } else {
        format!("Your approval · {}/{need}", input.approvals.min(need))
    };
    let tests_ok = input.checks_failed == 0 && input.checks_pending == 0;
    vec![
        gate(
            "review",
            "Agent review finished",
            pass_if(input.review_finished),
        ),
        gate(
            "findings",
            "No open high or medium findings",
            pass_if(input.review_finished && input.open_serious_findings == 0),
        ),
        gate(
            "mapping",
            "Every changed file mapped to a spec",
            match input.files_mapped {
                None => GateStatus::Unchecked,
                Some(ok) => pass_if(ok),
            },
        ),
        gate("tests", "Tests pass", pass_if(tests_ok)),
        gate("approval", approvals, pass_if(input.approvals >= need)),
    ]
}

/// The first gate that holds the merge back, if any.
pub fn blocking(gates: &[Gate]) -> Option<&Gate> {
    gates.iter().find(|g| g.status == GateStatus::Open)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ready() -> GateInput {
        GateInput {
            review_finished: true,
            open_serious_findings: 0,
            checks_total: 3,
            checks_failed: 0,
            checks_pending: 0,
            approvals: 1,
            critical: false,
            files_mapped: Some(true),
        }
    }

    fn status(input: &GateInput, id: &str) -> GateStatus {
        evaluate(input)
            .into_iter()
            .find(|g| g.id == id)
            .map(|g| g.status)
            .unwrap_or(GateStatus::Unchecked)
    }

    #[test]
    fn everything_in_order_passes() {
        let gates = evaluate(&ready());
        assert!(gates.iter().all(|g| g.status == GateStatus::Pass));
        assert!(blocking(&gates).is_none());
        let ids: Vec<_> = gates.iter().map(|g| g.id).collect();
        assert_eq!(ids, ["review", "findings", "mapping", "tests", "approval"]);
    }

    #[test]
    fn review_gate_needs_a_finished_review() {
        let input = GateInput {
            review_finished: false,
            ..ready()
        };
        assert_eq!(status(&input, "review"), GateStatus::Open);
        // Findings cannot be clean when nothing was reviewed.
        assert_eq!(status(&input, "findings"), GateStatus::Open);
    }

    #[test]
    fn findings_gate_counts_only_serious_open_findings() {
        let input = GateInput {
            open_serious_findings: 1,
            ..ready()
        };
        assert_eq!(status(&input, "findings"), GateStatus::Open);
        assert_eq!(status(&input, "review"), GateStatus::Pass);
        assert_eq!(status(&ready(), "findings"), GateStatus::Pass);
    }

    #[test]
    fn tests_gate_fails_on_a_failure_or_a_run_still_going_and_passes_without_ci() {
        assert_eq!(
            status(
                &GateInput {
                    checks_failed: 1,
                    ..ready()
                },
                "tests"
            ),
            GateStatus::Open
        );
        assert_eq!(
            status(
                &GateInput {
                    checks_pending: 1,
                    ..ready()
                },
                "tests"
            ),
            GateStatus::Open
        );
        assert_eq!(
            status(
                &GateInput {
                    checks_total: 0,
                    ..ready()
                },
                "tests"
            ),
            GateStatus::Pass
        );
    }

    #[test]
    fn approval_gate_needs_two_for_critical_repos() {
        let one = GateInput {
            critical: true,
            approvals: 1,
            ..ready()
        };
        assert_eq!(status(&one, "approval"), GateStatus::Open);
        let two = GateInput {
            critical: true,
            approvals: 2,
            ..ready()
        };
        assert_eq!(status(&two, "approval"), GateStatus::Pass);
        assert_eq!(
            status(
                &GateInput {
                    approvals: 0,
                    ..ready()
                },
                "approval"
            ),
            GateStatus::Open
        );
        let labels: Vec<_> = evaluate(&one).into_iter().map(|g| g.label).collect();
        assert!(labels[4].starts_with("Two owner approvals (critical) · 1/2"));
        assert_eq!(
            evaluate(&GateInput {
                approvals: 0,
                ..ready()
            })[4]
                .label,
            "Your approval · 0/1"
        );
    }

    #[test]
    fn mapping_gate_is_unchecked_until_mapping_exists_and_then_blocks() {
        let unknown = GateInput {
            files_mapped: None,
            ..ready()
        };
        assert_eq!(status(&unknown, "mapping"), GateStatus::Unchecked);
        assert!(blocking(&evaluate(&unknown)).is_none());
        assert_eq!(
            status(
                &GateInput {
                    files_mapped: Some(false),
                    ..ready()
                },
                "mapping"
            ),
            GateStatus::Open
        );
    }

    #[test]
    fn blocking_names_the_first_open_gate() {
        let input = GateInput {
            review_finished: false,
            approvals: 0,
            ..ready()
        };
        let gates = evaluate(&input);
        assert_eq!(blocking(&gates).map(|g| g.id), Some("review"));
    }
}
