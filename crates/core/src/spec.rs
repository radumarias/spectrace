//! Spec parser: one `spec/<flow>.md` file into steps, edges and requirement lines.
//!
//! The format is `docs/spec-format.md` (version 1). [`parse`] never fails: it
//! returns the best model it could build plus a list of [`Diagnostic`]s, each
//! naming the line. Any error means the spec must not be used by other tools;
//! [`Parsed::valid`] gives the spec only when there are none.
//!
//! # Positions
//!
//! The model is built for the writer as much as for readers. Every element
//! carries its 1-based line and a byte [`Span`] into the source it came from,
//! and the spans of the file's top-level parts tile the whole source:
//! `spec.head` covers everything before the first section, and each
//! [`Section::span`] runs from its heading to the next heading (or the end of
//! the file). So a writer can copy untouched parts byte for byte, replace only
//! the spans it changes and know where to append. The source itself is not
//! copied into the model; callers keep it next to the [`Spec`].
//!
//! Spans of single lines exclude the line ending. Line endings may be `\n` or
//! `\r\n`.

use std::collections::{HashMap, HashSet};

use crate::anchor::{is_valid_segment, is_valid_step_id, is_valid_tag};
use crate::diag::{Code, Diagnostic};

/// A byte range `start..end` in the parsed source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub struct Span {
    pub start: usize,
    pub end: usize,
}

impl Span {
    /// The text of this span, or `""` if it does not fit `source`.
    pub fn slice<'a>(&self, source: &'a str) -> &'a str {
        source.get(self.start..self.end).unwrap_or("")
    }
}

/// The result of parsing one spec file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    /// Best effort when there are errors; trust it only through [`Parsed::valid`].
    pub spec: Spec,
    /// Errors and warnings, ordered by line.
    pub diagnostics: Vec<Diagnostic>,
}

impl Parsed {
    pub fn has_errors(&self) -> bool {
        self.diagnostics.iter().any(Diagnostic::is_error)
    }

    /// The spec, if it has no errors (warnings are allowed).
    pub fn valid(&self) -> Option<&Spec> {
        (!self.has_errors()).then_some(&self.spec)
    }

    pub fn errors(&self) -> impl Iterator<Item = &Diagnostic> {
        self.diagnostics.iter().filter(|d| d.is_error())
    }

    pub fn warnings(&self) -> impl Iterator<Item = &Diagnostic> {
        self.diagnostics.iter().filter(|d| !d.is_error())
    }
}

/// One flow.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Spec {
    /// The flow id, from the file name (`checkout` for `spec/checkout.md`).
    pub flow: String,
    pub title: Option<Title>,
    pub diagram: Option<Diagram>,
    /// In file order.
    pub sections: Vec<Section>,
    /// From the start of the file to the first section heading (or the end of
    /// the file): the title, any prose and the diagram.
    pub head: Span,
}

impl Spec {
    pub fn section(&self, node: &str) -> Option<&Section> {
        self.sections.iter().find(|s| s.node == node)
    }

    /// Every step id with a section, in file order.
    pub fn step_ids(&self) -> Vec<String> {
        self.sections.iter().map(|s| s.id.clone()).collect()
    }

    /// Every requirement id (`checkout.failed/r2`), in file order.
    pub fn requirement_ids(&self) -> Vec<String> {
        self.sections
            .iter()
            .flat_map(|s| s.requirements.iter().map(move |r| r.id(&s.id)))
            .collect()
    }
}

/// `# Checkout {#checkout}`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Title {
    pub text: String,
    /// The id in `{#...}`, as written.
    pub id: String,
    pub line: usize,
    pub span: Span,
}

/// Layout direction of the flowchart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Direction {
    LR,
    RL,
    TD,
    TB,
    BT,
}

impl Direction {
    fn parse(s: &str) -> Option<Direction> {
        match s {
            "LR" => Some(Direction::LR),
            "RL" => Some(Direction::RL),
            "TD" => Some(Direction::TD),
            "TB" => Some(Direction::TB),
            "BT" => Some(Direction::BT),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Direction::LR => "LR",
            Direction::RL => "RL",
            Direction::TD => "TD",
            Direction::TB => "TB",
            Direction::BT => "BT",
        }
    }
}

/// The fenced `mermaid` block.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Diagram {
    /// `None` when the header is missing or wrong (an `S003` error).
    pub direction: Option<Direction>,
    /// Line of the opening fence.
    pub line: usize,
    /// Opening fence to the end of the closing fence line.
    pub span: Span,
    /// The lines between the fences, with the last line ending.
    pub body: Span,
    /// The `flowchart LR` line.
    pub header: Option<Located>,
    /// In file order, as are `edges`, `clicks` and `comments`.
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
    pub clicks: Vec<Click>,
    pub comments: Vec<Comment>,
}

impl Diagram {
    pub fn node(&self, id: &str) -> Option<&Node> {
        self.nodes.iter().find(|n| n.id == id)
    }
}

/// A line and its span, for elements with no content of their own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Located {
    pub line: usize,
    pub span: Span,
}

/// `failed[Declined]`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Node {
    pub id: String,
    pub label: String,
    pub line: usize,
    pub span: Span,
}

/// `pay -->|declined| failed`. Identified by source, label and target.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Edge {
    pub from: String,
    pub label: String,
    pub to: String,
    pub line: usize,
    pub span: Span,
}

/// `click failed href "spec://checkout.failed"`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Click {
    pub node: String,
    /// The step id after `spec://`.
    pub target: String,
    pub line: usize,
    pub span: Span,
}

/// `%% a comment`, text after `%%` as written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Comment {
    pub text: String,
    pub line: usize,
    pub span: Span,
}

/// `## Declined payment {#checkout.failed}` and what follows it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Section {
    /// The full step id, `checkout.failed`.
    pub id: String,
    /// The node part, `failed`.
    pub node: String,
    pub title: String,
    /// Line of the heading.
    pub line: usize,
    /// The heading line.
    pub heading: Span,
    /// The heading to the next heading or the end of the file, line endings included.
    pub span: Span,
    /// In file order.
    pub requirements: Vec<Requirement>,
    pub flow: Option<FlowQuote>,
}

/// `- WHEN <condition> THE SYSTEM SHALL <response>. {#r1}`
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Requirement {
    pub tag: String,
    /// Wrapped lines joined with single spaces.
    pub condition: String,
    /// Without the final `.`.
    pub response: String,
    pub line: usize,
    /// Last line, when the requirement wraps.
    pub end_line: usize,
    /// From the `-` to the end of the last line.
    pub span: Span,
}

impl Requirement {
    pub fn id(&self, step_id: &str) -> String {
        format!("{step_id}/{}", self.tag)
    }
}

/// `> @flow <reason>`, possibly over several `>` lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FlowQuote {
    /// The reason, lines joined with single spaces.
    pub text: String,
    pub line: usize,
    pub end_line: usize,
    pub span: Span,
}

/// Longest requirement line before `W003`.
pub const MAX_LINE: usize = 100;

/// Parses one spec file. `path` names the file in diagnostics and gives the
/// flow id (its file name without `.md`).
pub fn parse(path: &str, source: &str) -> Parsed {
    let mut p = Parser {
        file: path.to_string(),
        flow: flow_from_path(path).to_string(),
        src: source,
        lines: split_lines(source),
        diags: Vec::new(),
    };
    let spec = p.run();
    let mut diagnostics = p.diags;
    diagnostics.sort_by_key(|d| (d.line, d.code));
    Parsed { spec, diagnostics }
}

fn flow_from_path(path: &str) -> &str {
    let file = path.rsplit(['/', '\\']).next().unwrap_or(path);
    file.strip_suffix(".md").unwrap_or(file)
}

struct Line<'a> {
    /// 1-based.
    no: usize,
    /// Without the line ending.
    text: &'a str,
    start: usize,
    /// End of `text`.
    end: usize,
    /// Start of the next line.
    next: usize,
}

impl Line<'_> {
    fn span(&self) -> Span {
        Span {
            start: self.start,
            end: self.end,
        }
    }

    fn is_blank(&self) -> bool {
        self.text.trim().is_empty()
    }
}

fn split_lines(src: &str) -> Vec<Line<'_>> {
    let mut out = Vec::new();
    let mut start = 0;
    while start < src.len() {
        let rest = &src[start..];
        let (len, nl) = match rest.find('\n') {
            Some(i) => (i, 1),
            None => (rest.len(), 0),
        };
        let raw = &rest[..len];
        let text = raw.strip_suffix('\r').unwrap_or(raw);
        out.push(Line {
            no: out.len() + 1,
            text,
            start,
            end: start + text.len(),
            next: start + len + nl,
        });
        start += len + nl;
    }
    out
}

/// A fenced code block: line indices of its fences.
struct Fence {
    open: usize,
    close: Option<usize>,
    mermaid: bool,
}

/// Strips up to three spaces of indentation, as Markdown allows for block starts.
fn block_text(text: &str) -> Option<&str> {
    let trimmed = text.trim_start_matches(' ');
    (text.len() - trimmed.len() <= 3).then_some(trimmed)
}

/// `(fence char, fence length, info string)` for an opening fence line.
fn fence_open(text: &str) -> Option<(char, usize, &str)> {
    let t = block_text(text)?;
    let c = t.chars().next().filter(|c| *c == '`' || *c == '~')?;
    let len = t.len() - t.trim_start_matches(c).len();
    let info = t[len..].trim();
    (len >= 3 && !(c == '`' && info.contains('`'))).then_some((c, len, info))
}

fn fence_closes(text: &str, c: char, len: usize) -> bool {
    let Some(t) = block_text(text) else {
        return false;
    };
    let run = t.len() - t.trim_start_matches(c).len();
    run >= len && t[run..].trim().is_empty()
}

/// The heading text after `level` `#`s and a space, if the line is one.
fn heading(text: &str, level: usize) -> Option<&str> {
    let t = block_text(text)?;
    let hashes = t.len() - t.trim_start_matches('#').len();
    if hashes != level {
        return None;
    }
    let rest = &t[level..];
    if rest.is_empty() {
        Some("")
    } else {
        rest.strip_prefix([' ', '\t'])
    }
}

/// Splits `Declined payment {#checkout.failed}` into title and id.
fn heading_id(text: &str) -> Option<(&str, &str)> {
    let t = text.trim_end();
    let body = t.strip_suffix('}')?;
    let open = body.rfind("{#")?;
    Some((body[..open].trim(), &body[open + 2..]))
}

struct Parser<'a> {
    file: String,
    flow: String,
    src: &'a str,
    lines: Vec<Line<'a>>,
    diags: Vec<Diagnostic>,
}

impl<'a> Parser<'a> {
    fn report(&mut self, code: Code, line: usize, message: impl Into<String>) {
        self.diags.push(Diagnostic {
            code,
            file: self.file.clone(),
            line: line.max(1),
            message: message.into(),
        });
    }

    fn run(&mut self) -> Spec {
        // Pass 1: fences and headings outside them.
        let mut fences = Vec::new();
        let mut in_code = vec![false; self.lines.len()];
        let mut h1 = Vec::new();
        let mut h2 = Vec::new();
        let mut open: Option<(char, usize)> = None;
        for (i, line) in self.lines.iter().enumerate() {
            if let Some((c, len)) = open {
                in_code[i] = true;
                if fence_closes(line.text, c, len) {
                    open = None;
                    if let Some(f) = fences.last_mut() {
                        let f: &mut Fence = f;
                        f.close = Some(i);
                    }
                }
            } else if let Some((c, len, info)) = fence_open(line.text) {
                in_code[i] = true;
                open = Some((c, len));
                fences.push(Fence {
                    open: i,
                    close: None,
                    mermaid: info.split_whitespace().next() == Some("mermaid"),
                });
            } else if heading(line.text, 1).is_some() {
                h1.push(i);
            } else if heading(line.text, 2).is_some() {
                h2.push(i);
            }
        }
        let first_section = h2.first().copied();
        let head_end = first_section.map_or(self.src.len(), |i| self.lines[i].start);

        let title = self.title(&h1, &fences, first_section);
        let diagram = self.diagram(&fences, first_section);
        let mut sections = Vec::new();
        for (k, &start) in h2.iter().enumerate() {
            let end = h2.get(k + 1).copied().unwrap_or(self.lines.len());
            if let Some(s) = self.section(start, end, &in_code) {
                sections.push(s);
            }
        }
        // Requirement-like lines before the first section belong to no step.
        let head_lines = first_section.unwrap_or(self.lines.len());
        for item in self.items(0, head_lines, &in_code).0 {
            if looks_like_requirement(&item.text) {
                self.report(
                    Code::S010,
                    self.lines[item.first].no,
                    "requirement line outside a step section",
                );
            }
        }
        self.cross_check(diagram.as_ref(), &sections);

        Spec {
            flow: self.flow.clone(),
            title,
            diagram,
            sections,
            head: Span {
                start: 0,
                end: head_end,
            },
        }
    }

    fn title(
        &mut self,
        h1: &[usize],
        fences: &[Fence],
        first_section: Option<usize>,
    ) -> Option<Title> {
        if !is_valid_segment(&self.flow) {
            self.report(
                Code::S006,
                1,
                format!("file name `{}` is not a valid flow id", self.flow),
            );
        }
        let Some(&first) = h1.first() else {
            self.report(Code::S001, 1, "no title line (`# Title {#flow}`)");
            return None;
        };
        for &extra in &h1[1..] {
            self.report(Code::S001, self.lines[extra].no, "more than one H1");
        }
        let line = &self.lines[first];
        let (no, span, text) = (line.no, line.span(), heading(line.text, 1).unwrap_or(""));
        let mermaid = fences.iter().find(|f| f.mermaid).map(|f| f.open);
        if mermaid.is_some_and(|m| m < first) || first_section.is_some_and(|s| s < first) {
            self.report(
                Code::S001,
                no,
                "the title must come before the diagram and the sections",
            );
        }
        let Some((title, id)) = heading_id(text) else {
            self.report(Code::S001, no, "title has no `{#flow}` id");
            return Some(Title {
                text: text.trim().to_string(),
                id: String::new(),
                line: no,
                span,
            });
        };
        if !is_valid_segment(id) {
            self.report(
                Code::S006,
                no,
                format!("title id `{id}` is not a valid flow id"),
            );
        }
        if id != self.flow {
            self.report(
                Code::S001,
                no,
                format!(
                    "title id `{id}` does not match the file name `{}`",
                    self.flow
                ),
            );
        }
        Some(Title {
            text: title.to_string(),
            id: id.to_string(),
            line: no,
            span,
        })
    }

    fn diagram(&mut self, fences: &[Fence], first_section: Option<usize>) -> Option<Diagram> {
        let mut mermaid = fences.iter().filter(|f| f.mermaid);
        let Some(fence) = mermaid.next() else {
            self.report(Code::S002, 1, "no `mermaid` block");
            return None;
        };
        for extra in mermaid {
            self.report(
                Code::S002,
                self.lines[extra.open].no,
                "more than one `mermaid` block",
            );
        }
        let open_line = self.lines[fence.open].no;
        if first_section.is_some_and(|s| s < fence.open) {
            self.report(
                Code::S002,
                open_line,
                "the `mermaid` block must come before the first step section",
            );
        }
        let body_end = match fence.close {
            Some(c) => c,
            None => {
                self.report(Code::S002, open_line, "the `mermaid` block is not closed");
                self.lines.len()
            }
        };
        let last = fence.close.unwrap_or(self.lines.len().saturating_sub(1));
        let span = Span {
            start: self.lines[fence.open].start,
            end: self.lines.get(last).map_or(self.src.len(), |l| l.next),
        };
        let body = Span {
            start: self.lines[fence.open].next,
            end: self.lines.get(body_end).map_or(self.src.len(), |l| l.start),
        };

        let mut d = Diagram {
            direction: None,
            line: open_line,
            span,
            body,
            header: None,
            nodes: Vec::new(),
            edges: Vec::new(),
            clicks: Vec::new(),
            comments: Vec::new(),
        };
        let mut declared: HashSet<String> = HashSet::new();
        let mut edge_keys: HashSet<(String, String, String)> = HashSet::new();
        let mut header_seen = false;
        for i in fence.open + 1..body_end {
            let (no, span, raw) = {
                let l = &self.lines[i];
                (l.no, l.span(), l.text)
            };
            let t = raw.trim();
            if t.is_empty() {
                continue;
            }
            if !header_seen {
                header_seen = true;
                d.header = Some(Located { line: no, span });
                let words: Vec<&str> = t.split_whitespace().collect();
                if words.first() != Some(&"flowchart") {
                    self.report(
                        Code::S003,
                        no,
                        "the diagram must start with `flowchart <direction>`",
                    );
                } else {
                    match words.get(1).and_then(|w| Direction::parse(w)) {
                        Some(dir) if words.len() == 2 => d.direction = Some(dir),
                        _ => self.report(
                            Code::S003,
                            no,
                            "the flowchart direction must be one of LR RL TD TB BT",
                        ),
                    }
                }
                continue;
            }
            match diagram_line(t) {
                DiagramLine::Comment(text) => d.comments.push(Comment {
                    text: text.to_string(),
                    line: no,
                    span,
                }),
                DiagramLine::Node { id, label } => {
                    if !is_valid_segment(id) {
                        self.report(
                            Code::S006,
                            no,
                            format!("node id `{id}` breaks the id grammar"),
                        );
                    } else if !declared.insert(id.to_string()) {
                        self.report(Code::S006, no, format!("node `{id}` is declared twice"));
                        continue;
                    }
                    d.nodes.push(Node {
                        id: id.to_string(),
                        label: label.to_string(),
                        line: no,
                        span,
                    });
                }
                DiagramLine::Edge { from, label, to } => {
                    let ends: &[&str] = if from == to { &[from] } else { &[from, to] };
                    for &id in ends {
                        if !is_valid_segment(id) {
                            self.report(
                                Code::S006,
                                no,
                                format!("node id `{id}` breaks the id grammar"),
                            );
                        } else if !declared.contains(id) {
                            let later = d_later_declares(&self.lines[i + 1..body_end], id);
                            self.report(
                                Code::S007,
                                no,
                                if later {
                                    format!("edge uses node `{id}` before it is declared")
                                } else {
                                    format!("edge names undeclared node `{id}`")
                                },
                            );
                        }
                    }
                    let key = (from.to_string(), label.to_string(), to.to_string());
                    if !edge_keys.insert(key) {
                        self.report(
                            Code::S014,
                            no,
                            format!("edge `{from} -->|{label}| {to}` appears twice"),
                        );
                    }
                    d.edges.push(Edge {
                        from: from.to_string(),
                        label: label.to_string(),
                        to: to.to_string(),
                        line: no,
                        span,
                    });
                }
                DiagramLine::Click { node, target } => {
                    if !is_valid_segment(node) {
                        self.report(
                            Code::S006,
                            no,
                            format!("node id `{node}` breaks the id grammar"),
                        );
                    } else if !declared.contains(node) {
                        self.report(
                            Code::S007,
                            no,
                            format!("`click` names undeclared node `{node}`"),
                        );
                    }
                    let want = format!("{}.{node}", self.flow);
                    if target != want {
                        self.report(
                            Code::S013,
                            no,
                            format!("`click {node}` links to `spec://{target}`, expected `spec://{want}`"),
                        );
                    }
                    d.clicks.push(Click {
                        node: node.to_string(),
                        target: target.to_string(),
                        line: no,
                        span,
                    });
                }
                DiagramLine::Bad(code, message) => self.report(code, no, message),
            }
        }
        if !header_seen {
            self.report(
                Code::S003,
                open_line,
                "the `mermaid` block is empty, expected `flowchart <direction>`",
            );
        }
        Some(d)
    }

    fn section(&mut self, start: usize, end: usize, in_code: &[bool]) -> Option<Section> {
        let (no, heading_span, text) = {
            let l = &self.lines[start];
            (l.no, l.span(), heading(l.text, 2).unwrap_or(""))
        };
        let span = Span {
            start: self.lines[start].start,
            end: self.lines.get(end).map_or(self.src.len(), |l| l.start),
        };
        let Some((title, id)) = heading_id(text) else {
            self.report(Code::S008, no, "section heading has no `{#flow.node}` id");
            return None;
        };
        if !is_valid_step_id(id) {
            self.report(
                Code::S006,
                no,
                format!("section id `{id}` is not a valid step id"),
            );
            return None;
        }
        let (flow, node) = id.split_once('.').unwrap_or((id, ""));
        if flow != self.flow {
            self.report(
                Code::S009,
                no,
                format!("section id `{id}` is not in flow `{}`", self.flow),
            );
        }

        let (items, quotes) = self.items(start + 1, end, in_code);
        let mut requirements = Vec::new();
        let mut tags: HashSet<String> = HashSet::new();
        for item in items {
            if !looks_like_requirement(&item.text) {
                continue;
            }
            let first = &self.lines[item.first];
            let (line, span_start) = (first.no, first.start);
            let last = &self.lines[item.last];
            let (end_line, span_end) = (last.no, last.end);
            if !item.top_level_dash {
                self.report(
                    Code::S010,
                    line,
                    "a requirement must be a top-level `- ` list item",
                );
                continue;
            }
            let (condition, response, tag) = match parse_requirement(&item.text) {
                Ok(r) => r,
                Err(why) => {
                    self.report(Code::S010, line, format!("requirement line {why}"));
                    continue;
                }
            };
            if !is_valid_tag(tag) {
                self.report(
                    Code::S011,
                    line,
                    format!("tag `{tag}` is not `r` followed by a positive integer"),
                );
                continue;
            }
            if !tags.insert(tag.to_string()) {
                self.report(Code::S011, line, format!("tag `{tag}` repeats in `{id}`"));
                continue;
            }
            for k in item.first..=item.last {
                if self.lines[k].text.chars().count() > MAX_LINE {
                    let at = self.lines[k].no;
                    self.report(
                        Code::W003,
                        at,
                        format!("requirement `{tag}` has a line over {MAX_LINE} characters"),
                    );
                    break;
                }
            }
            requirements.push(Requirement {
                tag: tag.to_string(),
                condition: condition.to_string(),
                response: response.to_string(),
                line,
                end_line,
                span: Span {
                    start: span_start,
                    end: span_end,
                },
            });
        }

        let mut flows = quotes.into_iter().filter(|q| q.flow);
        let flow_quote = flows.next().map(|q| {
            let first = &self.lines[q.first];
            let last = &self.lines[q.last];
            FlowQuote {
                text: q.text,
                line: first.no,
                end_line: last.no,
                span: Span {
                    start: first.start,
                    end: last.end,
                },
            }
        });
        for extra in flows {
            let at = self.lines[extra.first].no;
            self.report(
                Code::S012,
                at,
                format!("more than one `@flow` quote in `{id}`"),
            );
        }

        Some(Section {
            id: id.to_string(),
            node: node.to_string(),
            title: title.to_string(),
            line: no,
            heading: heading_span,
            span,
            requirements,
            flow: flow_quote,
        })
    }

    /// List items and blockquotes in lines `start..end`, outside code blocks.
    fn items(&self, start: usize, end: usize, in_code: &[bool]) -> (Vec<Item>, Vec<Quote>) {
        let mut items: Vec<Item> = Vec::new();
        let mut quotes: Vec<Quote> = Vec::new();
        // Indentation of the open list item, if any.
        let mut item_indent: Option<usize> = None;
        let mut quote_open = false;
        for (i, line) in self.lines.iter().enumerate().take(end).skip(start) {
            if in_code.get(i).copied().unwrap_or(false) || line.is_blank() || heading_any(line.text)
            {
                item_indent = None;
                quote_open = false;
                continue;
            }
            let text = line.text;
            let indent = text.len() - text.trim_start_matches(' ').len();
            if let Some(q) = block_text(text).and_then(|t| t.strip_prefix('>')) {
                item_indent = None;
                let content = q.trim();
                match quotes.last_mut() {
                    Some(last) if quote_open => {
                        last.last = i;
                        if last.flow && !content.is_empty() {
                            push_joined(&mut last.text, content);
                        }
                    }
                    _ => {
                        let flow = content == "@flow" || content.starts_with("@flow ");
                        let reason = content.strip_prefix("@flow").unwrap_or("").trim();
                        quotes.push(Quote {
                            first: i,
                            last: i,
                            flow,
                            text: reason.to_string(),
                        });
                        quote_open = true;
                    }
                }
                continue;
            }
            quote_open = false;
            if let Some((dash, content)) = list_marker(text) {
                // An item indented under the open one is a nested item.
                item_indent = Some(indent);
                items.push(Item {
                    first: i,
                    last: i,
                    top_level_dash: dash && indent == 0,
                    text: content.trim().to_string(),
                });
                continue;
            }
            match (item_indent, items.last_mut()) {
                (Some(base), Some(last)) if indent >= base + 2 => {
                    last.last = i;
                    push_joined(&mut last.text, text.trim());
                }
                _ => item_indent = None,
            }
        }
        (items, quotes)
    }

    fn cross_check(&mut self, diagram: Option<&Diagram>, sections: &[Section]) {
        let mut seen: HashMap<&str, usize> = HashMap::new();
        for s in sections {
            if let Some(first) = seen.insert(&s.id, s.line) {
                self.report(
                    Code::S009,
                    s.line,
                    format!("section `{}` repeats (first on line {first})", s.id),
                );
            }
            if s.requirements.is_empty() {
                self.report(
                    Code::W001,
                    s.line,
                    format!("step `{}` has no requirement lines", s.id),
                );
            }
        }
        let Some(d) = diagram else {
            return;
        };
        let nodes: HashSet<&str> = d.nodes.iter().map(|n| n.id.as_str()).collect();
        for s in sections {
            if s.id.split_once('.').map(|(f, _)| f) == Some(self.flow.as_str())
                && !nodes.contains(s.node.as_str())
            {
                self.report(
                    Code::S008,
                    s.line,
                    format!("section `{}` is not a node in the diagram", s.id),
                );
            }
        }
        for n in &d.nodes {
            let id = format!("{}.{}", self.flow, n.id);
            if !sections.iter().any(|s| s.id == id) {
                self.report(
                    Code::S008,
                    n.line,
                    format!("node `{}` has no section `## ... {{#{id}}}`", n.id),
                );
            }
            if !d.edges.iter().any(|e| e.from == n.id || e.to == n.id) {
                self.report(Code::W002, n.line, format!("node `{}` has no edges", n.id));
            }
        }
    }
}

fn heading_any(text: &str) -> bool {
    block_text(text).is_some_and(|t| {
        let hashes = t.len() - t.trim_start_matches('#').len();
        (1..=6).contains(&hashes) && matches!(t[hashes..].chars().next(), None | Some(' ' | '\t'))
    })
}

fn d_later_declares(rest: &[Line<'_>], id: &str) -> bool {
    rest.iter()
        .any(|l| matches!(diagram_line(l.text.trim()), DiagramLine::Node { id: n, .. } if n == id))
}

fn push_joined(text: &mut String, more: &str) {
    if !text.is_empty() {
        text.push(' ');
    }
    text.push_str(more);
}

struct Item {
    first: usize,
    last: usize,
    /// `- ` at column 0, the only form a requirement may take.
    top_level_dash: bool,
    /// Content after the marker, wrapped lines joined with single spaces.
    text: String,
}

struct Quote {
    first: usize,
    last: usize,
    flow: bool,
    text: String,
}

/// For a list item line: whether the marker is `-`, and the content after it.
fn list_marker(text: &str) -> Option<(bool, &str)> {
    let t = text.trim_start_matches(' ');
    for m in ['-', '*', '+'] {
        if let Some(rest) = t.strip_prefix(m) {
            if rest.is_empty() || rest.starts_with([' ', '\t']) {
                // `---` and `***` are thematic breaks, not items.
                if rest.trim().chars().all(|c| c == m) && !rest.trim().is_empty() {
                    return None;
                }
                return Some((m == '-', rest));
            }
        }
    }
    let digits = t.len() - t.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    if (1..=9).contains(&digits) {
        let rest = &t[digits..];
        if let Some(after) = rest.strip_prefix(['.', ')']) {
            if after.is_empty() || after.starts_with([' ', '\t']) {
                return Some((false, after));
            }
        }
    }
    None
}

fn looks_like_requirement(text: &str) -> bool {
    text.starts_with("WHEN") || text.contains("THE SYSTEM SHALL")
}

const SHALL: &str = "THE SYSTEM SHALL";

/// `WHEN <condition> THE SYSTEM SHALL <response>. {#tag}` into its parts.
/// The error completes "requirement line ...".
fn parse_requirement(text: &str) -> Result<(&str, &str, &str), String> {
    let rest = text
        .strip_prefix("WHEN ")
        .ok_or("must start with `WHEN `")?;
    let open = rest.rfind("{#").ok_or("has no `{#tag}` at the end")?;
    let after = &rest[open + 2..];
    let close = after.find('}').ok_or("has an unclosed `{#`")?;
    let tag = &after[..close];
    if !after[close + 1..].trim().is_empty() {
        return Err("continues past its `{#tag}`".into());
    }
    let body = &rest[..open];
    let trimmed = body.trim_end();
    if trimmed.len() == body.len() {
        return Err("needs a space before `{#tag}`".into());
    }
    let body = trimmed
        .strip_suffix('.')
        .ok_or("must end with `.` before `{#tag}`")?;
    match body.matches(SHALL).count() {
        0 => return Err("has no `THE SYSTEM SHALL`".into()),
        1 => {}
        _ => return Err("has more than one `THE SYSTEM SHALL`".into()),
    }
    let (condition, response) = body
        .split_once(" THE SYSTEM SHALL ")
        .ok_or("needs spaces around `THE SYSTEM SHALL`")?;
    let (condition, response) = (condition.trim(), response.trim());
    if condition.is_empty() {
        return Err("has an empty condition".into());
    }
    if response.is_empty() {
        return Err("has an empty response".into());
    }
    if condition
        .split_whitespace()
        .chain(response.split_whitespace())
        .any(|w| w == "WHEN")
    {
        return Err("has more than one `WHEN`".into());
    }
    Ok((condition, response, tag))
}

enum DiagramLine<'a> {
    Comment(&'a str),
    Node {
        id: &'a str,
        label: &'a str,
    },
    Edge {
        from: &'a str,
        label: &'a str,
        to: &'a str,
    },
    Click {
        node: &'a str,
        target: &'a str,
    },
    Bad(Code, String),
}

const FORBIDDEN: [char; 4] = ['[', ']', '|', '"'];

fn is_plain_id(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn good_label(s: &str) -> bool {
    !s.trim().is_empty() && !s.contains(FORBIDDEN)
}

/// Classifies one trimmed, non-blank diagram line after the header.
fn diagram_line(t: &str) -> DiagramLine<'_> {
    if let Some(text) = t.strip_prefix("%%") {
        return DiagramLine::Comment(text);
    }
    // `id[Label]`
    if let Some(open) = t.find('[') {
        let id = &t[..open];
        if let Some(label) = t[open + 1..].strip_suffix(']') {
            if is_plain_id(id) && good_label(label) {
                return DiagramLine::Node {
                    id,
                    label: label.trim(),
                };
            }
        }
    }
    let words: Vec<&str> = t.split_whitespace().collect();
    if words.first() == Some(&"click") {
        return click_line(&words);
    }
    if t.contains("-->") {
        return edge_line(t);
    }
    if ["---", "-.-", "-.->", "==>", "~~~", "--o", "--x", "<--"]
        .iter()
        .any(|a| t.contains(a))
    {
        return DiagramLine::Bad(Code::S004, "only `-->|label|` arrows are allowed".into());
    }
    let first = words.first().copied().unwrap_or("");
    let what = match first {
        "subgraph" | "end" | "style" | "classDef" | "class" | "linkStyle" | "direction" => {
            format!("`{first}` is not allowed in a spec diagram")
        }
        _ if is_plain_id(first) && words.len() == 1 => {
            format!("node `{first}` needs a label: `{first}[Label]`")
        }
        _ => "not a node, labelled edge, `click` or comment".to_string(),
    };
    DiagramLine::Bad(Code::S004, what)
}

fn click_line<'a>(words: &[&'a str]) -> DiagramLine<'a> {
    let bad = || {
        DiagramLine::Bad(
            Code::S004,
            "`click` must be `click <node> href \"spec://<flow>.<node>\"`".into(),
        )
    };
    let [_, node, "href", quoted] = words else {
        return bad();
    };
    let Some(target) = quoted
        .strip_prefix("\"spec://")
        .and_then(|q| q.strip_suffix('"'))
    else {
        return bad();
    };
    if !is_plain_id(node) {
        return bad();
    }
    DiagramLine::Click { node, target }
}

fn edge_line(t: &str) -> DiagramLine<'_> {
    let Some(at) = t.find("-->") else {
        return DiagramLine::Bad(Code::S004, "not a labelled edge".into());
    };
    let from = t[..at].trim();
    let rest = &t[at + 3..];
    if from.contains("--") {
        return DiagramLine::Bad(
            Code::S004,
            "edge labels are written `a -->|label| b`, not `a -- label --> b`".into(),
        );
    }
    let Some(labelled) = rest.strip_prefix('|') else {
        return DiagramLine::Bad(
            Code::S005,
            "edge has no label, write `a -->|label| b`".into(),
        );
    };
    let Some(close) = labelled.find('|') else {
        return DiagramLine::Bad(Code::S004, "edge label is not closed with `|`".into());
    };
    let label = &labelled[..close];
    let to = labelled[close + 1..].trim();
    if label.trim().is_empty() {
        return DiagramLine::Bad(Code::S005, "edge has an empty label".into());
    }
    if !is_plain_id(from) || !is_plain_id(to) {
        let message = if to.contains("-->") {
            "one edge per line, chains are not allowed"
        } else if [from, to].iter().any(|s| s.contains(['[', '(', '{'])) {
            "declare nodes on their own line, inline declarations are not allowed"
        } else {
            "an edge joins two node ids: `a -->|label| b`"
        };
        return DiagramLine::Bad(Code::S004, message.into());
    }
    if label.contains(FORBIDDEN) {
        return DiagramLine::Bad(Code::S004, "edge label may not contain `[ ] | \"`".into());
    }
    DiagramLine::Edge {
        from,
        label: label.trim(),
        to,
    }
}
