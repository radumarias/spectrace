//! Diagnostics: what the spec parser (and later the anchor checker) reports.
//!
//! Codes and wording of the conditions follow `docs/spec-format.md`,
//! "What is an error".

use std::fmt;

/// Whether a diagnostic blocks the tools that read the spec.
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Severity {
    /// The spec is unusable until this is fixed.
    Error,
    /// Shown, never blocks.
    Warning,
}

impl fmt::Display for Severity {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Severity::Error => "error",
            Severity::Warning => "warning",
        })
    }
}

/// A diagnostic code from the spec format doc.
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Code {
    /// No title line, more than one H1, or the title id is missing or does not match the file name.
    S001,
    /// No `mermaid` block, or more than one.
    S002,
    /// The block is not a `flowchart`, or the direction is not one of `LR RL TD TB BT`.
    S003,
    /// A diagram line is not a node, labelled edge, `click` or comment.
    S004,
    /// An edge has no label, an empty label or an unlabelled arrow.
    S005,
    /// An id breaks the id grammar, or a node is declared twice.
    S006,
    /// An edge or `click` names an undeclared node.
    S007,
    /// A node has no section, or a section's id is not a node.
    S008,
    /// A section id repeats, or its flow part is not this flow.
    S009,
    /// A list item looks like a requirement but does not parse.
    S010,
    /// A tag repeats within a step, or is not `r` followed by a positive integer.
    S011,
    /// A section has more than one `@flow` quote.
    S012,
    /// A `click` href does not match the node it is on.
    S013,
    /// Two identical edges (same source, label and target).
    S014,
    /// A step has no requirement lines.
    W001,
    /// A node has no edges at all.
    W002,
    /// A requirement line is over 100 characters on one line.
    W003,
}

impl Code {
    pub fn severity(self) -> Severity {
        match self {
            Code::W001 | Code::W002 | Code::W003 => Severity::Warning,
            _ => Severity::Error,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Code::S001 => "S001",
            Code::S002 => "S002",
            Code::S003 => "S003",
            Code::S004 => "S004",
            Code::S005 => "S005",
            Code::S006 => "S006",
            Code::S007 => "S007",
            Code::S008 => "S008",
            Code::S009 => "S009",
            Code::S010 => "S010",
            Code::S011 => "S011",
            Code::S012 => "S012",
            Code::S013 => "S013",
            Code::S014 => "S014",
            Code::W001 => "W001",
            Code::W002 => "W002",
            Code::W003 => "W003",
        }
    }
}

impl fmt::Display for Code {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One problem found in a file, at a 1-based line.
#[cfg_attr(feature = "serde", derive(serde::Serialize))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagnostic {
    pub code: Code,
    pub file: String,
    pub line: usize,
    pub message: String,
}

impl Diagnostic {
    pub fn severity(&self) -> Severity {
        self.code.severity()
    }

    pub fn is_error(&self) -> bool {
        self.severity() == Severity::Error
    }
}

impl fmt::Display for Diagnostic {
    /// `spec/checkout.md:12: error S005: edge from pay to failed has no label`
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{}:{}: {} {}: {}",
            self.file,
            self.line,
            self.severity(),
            self.code,
            self.message
        )
    }
}
