//! Spec writer: an edited [`Spec`] back into Markdown and Mermaid, changing only
//! the lines that differ.
//!
//! The writer never renders a whole file. It takes the source a spec was parsed
//! from, that parsed model (`original`) and a changed copy of it (`edited`), works
//! out what changed and patches only those lines of the source. Everything else
//! is copied byte for byte, so a spec PR's diff is exactly the edit, and an
//! untouched spec comes back identical.
//!
//! # How elements are matched
//!
//! - Nodes by id, sections by step id, requirements by tag within their section.
//! - Edges, `click` lines and comments by their [`Span`]: an element of `edited`
//!   whose span is that of an element of `original` is that element, possibly
//!   changed. Clone the original and change fields in place to edit one; give a
//!   new element `Span::default()`.
//! - Anything in `original` with no match in `edited` is deleted; anything in
//!   `edited` with no match is new.
//!
//! # Where things go
//!
//! Changed elements are rewritten on their own lines, keeping the indentation.
//! New nodes, edges, `click` lines and comments go at the end of their group in
//! the diagram, new requirements after the section's last requirement, new
//! sections at the end of the file. The order of existing elements is the
//! file's: moving an element within a `Vec` of `edited` does not move it.
//!
//! Node positions are not part of a spec (they live in the editor's
//! `spec/<flow>.layout.json`), so moving a box never reaches the writer.
//!
//! # Guarantees
//!
//! [`write`] re-parses what it wrote. It returns an error rather than output that
//! has spec errors ([`WriteError::Invalid`]) or that parses into a different
//! model than `edited` ([`WriteError::Mismatch`], for example a label with a line
//! break in it).

use std::collections::HashSet;
use std::fmt;

use crate::diag::Diagnostic;
use crate::spec::{
    parse, Action, Click, Comment, Diagram, Edge, FlowQuote, Node, Requirement, Section, Span,
    Spec, MAX_LINE,
};

/// Why [`write`] gave no output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WriteError {
    /// The change is not one the writer makes, such as removing the title or
    /// the diagram, or changing the flow id.
    Unsupported(String),
    /// The output would have spec errors. The diagnostics are for the output.
    Invalid(Vec<Diagnostic>),
    /// The output parses, but not into `edited`. The message names the first
    /// difference.
    Mismatch(String),
}

impl fmt::Display for WriteError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            WriteError::Unsupported(why) => write!(f, "unsupported edit: {why}"),
            WriteError::Invalid(diags) => {
                write!(f, "the written spec has errors")?;
                for d in diags.iter().filter(|d| d.is_error()) {
                    write!(f, "\n{d}")?;
                }
                Ok(())
            }
            WriteError::Mismatch(why) => {
                write!(f, "the written spec does not read back as edited: {why}")
            }
        }
    }
}

impl std::error::Error for WriteError {}

/// Writes `edited` as a change to `source`, which `original` was parsed from.
///
/// When `edited` equals `original` the result is `source` unchanged.
pub fn write(source: &str, original: &Spec, edited: &Spec) -> Result<String, WriteError> {
    if edited.flow != original.flow {
        return Err(WriteError::Unsupported(format!(
            "the flow id is the file name; `{}` cannot become `{}`",
            original.flow, edited.flow
        )));
    }
    if original.head.end > source.len() || source.get(..original.head.end).is_none() {
        return Err(WriteError::Unsupported(
            "`original` was not parsed from this source".into(),
        ));
    }
    let mut w = Writer::new(source);
    w.title(original, edited)?;
    match (&original.diagram, &edited.diagram) {
        (Some(o), Some(e)) => w.diagram(o, e)?,
        (None, None) => {}
        _ => {
            return Err(WriteError::Unsupported(
                "adding or removing the diagram".into(),
            ))
        }
    }
    w.sections(original, edited);
    let out = w.finish(original, edited);

    let path = format!("spec/{}.md", original.flow);
    let reread = parse(&path, &out);
    if reread.has_errors() {
        return Err(WriteError::Invalid(reread.diagnostics));
    }
    if let Some(why) = first_difference(&Shape::of(edited), &Shape::of(&reread.spec)) {
        return Err(WriteError::Mismatch(why));
    }
    Ok(out)
}

impl Spec {
    /// Adds a step: a node, a `click` line if the diagram has any, and an empty
    /// section. Returns `false` if the node already exists or there is no diagram.
    pub fn add_step(&mut self, node: &str, label: &str, title: &str) -> bool {
        let Some(d) = self.diagram.as_mut() else {
            return false;
        };
        if d.node(node).is_some() || self.sections.iter().any(|s| s.node == node) {
            return false;
        }
        d.nodes.push(Node {
            id: node.to_string(),
            label: label.to_string(),
            line: 0,
            span: Span::default(),
        });
        let id = format!("{}.{node}", self.flow);
        if !d.clicks.is_empty() {
            d.clicks.push(Click {
                node: node.to_string(),
                target: id.clone(),
                line: 0,
                span: Span::default(),
            });
        }
        self.sections.push(Section {
            id,
            node: node.to_string(),
            title: title.to_string(),
            line: 0,
            heading: Span::default(),
            span: Span::default(),
            requirements: Vec::new(),
            flow: None,
        });
        true
    }

    /// Removes a step: its node, every edge to or from it, its `click` lines and
    /// its section. Returns `false` if there was no such node.
    pub fn remove_step(&mut self, node: &str) -> bool {
        let Some(d) = self.diagram.as_mut() else {
            return false;
        };
        let before = d.nodes.len();
        d.nodes.retain(|n| n.id != node);
        if d.nodes.len() == before {
            return false;
        }
        d.edges.retain(|e| e.from != node && e.to != node);
        d.clicks.retain(|c| c.node != node);
        d.actions.retain(|a| a.node != node);
        self.sections.retain(|s| s.node != node);
        true
    }

    /// Adds the edge `from -->|label| to`. Returns `false` if it exists.
    pub fn add_edge(&mut self, from: &str, label: &str, to: &str) -> bool {
        let Some(d) = self.diagram.as_mut() else {
            return false;
        };
        if d.edge(from, label, to).is_some() {
            return false;
        }
        d.edges.push(Edge {
            from: from.to_string(),
            label: label.to_string(),
            to: to.to_string(),
            line: 0,
            span: Span::default(),
        });
        true
    }

    /// Removes the edge `from -->|label| to`. Returns `false` if there was none.
    pub fn remove_edge(&mut self, from: &str, label: &str, to: &str) -> bool {
        let Some(d) = self.diagram.as_mut() else {
            return false;
        };
        let before = d.edges.len();
        d.edges
            .retain(|e| !(e.from == from && e.label == label && e.to == to));
        d.edges.len() != before
    }

    pub fn section_mut(&mut self, node: &str) -> Option<&mut Section> {
        self.sections.iter_mut().find(|s| s.node == node)
    }
}

impl Diagram {
    pub fn edge(&self, from: &str, label: &str, to: &str) -> Option<&Edge> {
        self.edges
            .iter()
            .find(|e| e.from == from && e.label == label && e.to == to)
    }

    pub fn node_mut(&mut self, id: &str) -> Option<&mut Node> {
        self.nodes.iter_mut().find(|n| n.id == id)
    }
}

impl Section {
    /// The tag for a new requirement: one past the highest tag in this section
    /// and in `original`, the same section as parsed. Passing the original
    /// keeps a tag deleted in this edit from coming back. Tags retired in
    /// earlier commits are only in the file's history, so the highest tag must
    /// never have been deleted for this to be safe on its own.
    pub fn next_tag(&self, original: Option<&Section>) -> String {
        let highest = self
            .requirements
            .iter()
            .chain(original.into_iter().flat_map(|s| s.requirements.iter()))
            .filter_map(|r| r.tag.strip_prefix('r')?.parse::<u64>().ok())
            .max()
            .unwrap_or(0);
        format!("r{}", highest.saturating_add(1))
    }

    /// Appends a requirement with [`Section::next_tag`] and returns its tag.
    pub fn add_requirement(
        &mut self,
        condition: &str,
        response: &str,
        original: Option<&Section>,
    ) -> String {
        let tag = self.next_tag(original);
        self.requirements.push(Requirement {
            tag: tag.clone(),
            condition: condition.to_string(),
            response: response.to_string(),
            line: 0,
            end_line: 0,
            span: Span::default(),
        });
        tag
    }

    pub fn requirement_mut(&mut self, tag: &str) -> Option<&mut Requirement> {
        self.requirements.iter_mut().find(|r| r.tag == tag)
    }
}

// ---- Rendering, one element at a time.

fn render_title(text: &str, id: &str) -> String {
    if text.is_empty() {
        format!("# {{#{id}}}")
    } else {
        format!("# {text} {{#{id}}}")
    }
}

fn render_heading(title: &str, id: &str) -> String {
    if title.is_empty() {
        format!("## {{#{id}}}")
    } else {
        format!("## {title} {{#{id}}}")
    }
}

fn render_node(n: &Node) -> String {
    format!("{}[{}]", n.id, n.label)
}

fn render_edge(e: &Edge) -> String {
    format!("{} -->|{}| {}", e.from, e.label, e.to)
}

fn render_click(c: &Click) -> String {
    format!("click {} href \"spec://{}\"", c.node, c.target)
}

fn render_action(a: &Action) -> String {
    match &a.tooltip {
        Some(t) => format!("click {} href \"{}\" \"{t}\"", a.node, a.href),
        None => format!("click {} href \"{}\"", a.node, a.href),
    }
}

fn render_comment(c: &Comment) -> String {
    format!("%%{}", c.text)
}

fn render_flow(q: &FlowQuote) -> String {
    if q.text.is_empty() {
        "> @flow".to_string()
    } else {
        format!("> @flow {}", q.text)
    }
}

/// One line, or wrapped at spaces onto lines indented by two when it is over
/// [`MAX_LINE`] characters, as `docs/spec-format.md` asks.
fn render_requirement(r: &Requirement, nl: &str) -> String {
    let one = format!(
        "- WHEN {} THE SYSTEM SHALL {}. {{#{}}}",
        r.condition, r.response, r.tag
    );
    // Runs of spaces would be joined back as one, so such text stays on one line.
    if one.chars().count() <= MAX_LINE || one.contains("  ") {
        return one;
    }
    let mut out = String::new();
    let mut line = String::new();
    let words: Vec<&str> = one.split(' ').collect();
    for (i, word) in words.iter().enumerate() {
        // The tag stays with the word before it.
        let rest = match words.get(i + 1) {
            Some(next) if next.starts_with("{#") => 1 + next.chars().count(),
            _ => 0,
        };
        let fits = line.chars().count() + 1 + word.chars().count() + rest <= MAX_LINE;
        if line.is_empty() || fits || !safe_line_start(word) || word.starts_with("{#") {
            if !line.is_empty() {
                line.push(' ');
            }
            line.push_str(word);
        } else {
            out.push_str(&line);
            out.push_str(nl);
            line = format!("  {word}");
        }
    }
    out.push_str(&line);
    out
}

/// Whether a wrapped line may start with `word` and still read as a
/// continuation, not as a list item, quote, heading or fence.
fn safe_line_start(word: &str) -> bool {
    !word.starts_with(|c: char| "-*+>#`~|".contains(c) || c.is_ascii_digit())
}

// ---- Patching the source.

/// Replace `start..end` of the source with `text`. An insertion has
/// `start == end`; `seq` orders insertions at the same place.
struct Patch {
    start: usize,
    end: usize,
    seq: u8,
    text: String,
}

struct Writer<'a> {
    src: &'a str,
    nl: &'static str,
    patches: Vec<Patch>,
}

/// Insertion order at one position.
const SEQ_REPLACE: u8 = 0;
const SEQ_NODE: u8 = 1;
const SEQ_EDGE: u8 = 2;
const SEQ_CLICK: u8 = 3;
const SEQ_ACTION: u8 = 4;
const SEQ_COMMENT: u8 = 5;
const SEQ_REQ: u8 = 1;
const SEQ_FLOW: u8 = 2;

impl<'a> Writer<'a> {
    fn new(src: &'a str) -> Self {
        Writer {
            src,
            nl: if src.contains("\r\n") { "\r\n" } else { "\n" },
            patches: Vec::new(),
        }
    }

    fn replace(&mut self, span: Span, text: String) {
        if span.slice(self.src) != text {
            self.patches.push(Patch {
                start: span.start,
                end: span.end,
                seq: SEQ_REPLACE,
                text,
            });
        }
    }

    fn insert(&mut self, at: usize, seq: u8, text: String) {
        if !text.is_empty() {
            self.patches.push(Patch {
                start: at,
                end: at,
                seq,
                text,
            });
        }
    }

    fn delete(&mut self, start: usize, end: usize) {
        self.patches.push(Patch {
            start,
            end,
            seq: SEQ_REPLACE,
            text: String::new(),
        });
    }

    /// The start of the line after the one `pos` is on (or the end of the source).
    fn next_line(&self, pos: usize) -> usize {
        match self.src.get(pos..).and_then(|rest| rest.find('\n')) {
            Some(i) => pos + i + 1,
            None => self.src.len(),
        }
    }

    /// Whether the source has a line ending before `pos`'s line ends.
    fn ends_line(&self, pos: usize) -> bool {
        self.src.get(pos..).is_some_and(|rest| rest.contains('\n'))
    }

    /// Text to insert at the end of the line holding `pos`: `lines`, each
    /// followed by a line ending, after one if that line has none.
    fn after_line(&self, pos: usize, lines: &[String]) -> (usize, String) {
        let mut text = String::new();
        if !self.ends_line(pos) && !lines.is_empty() {
            text.push_str(self.nl);
        }
        for l in lines {
            text.push_str(l);
            text.push_str(self.nl);
        }
        (self.next_line(pos), text)
    }

    /// Whether the line starting at `start` is blank. `false` past the end.
    fn blank_at(&self, start: usize) -> bool {
        start < self.src.len()
            && self
                .src
                .get(start..self.next_line(start))
                .is_some_and(|l| l.trim().is_empty())
    }

    /// Whether the line before the one starting at `start` is blank.
    fn blank_before(&self, start: usize) -> bool {
        if start == 0 {
            return false;
        }
        let before = self.src.get(..start - 1).unwrap_or("");
        let prev = before.rfind('\n').map_or(0, |i| i + 1);
        self.src
            .get(prev..start)
            .is_some_and(|l| l.trim().is_empty())
    }

    fn indent_of(&self, span: Span) -> &'a str {
        let line = span.slice(self.src);
        &line[..line.len() - line.trim_start().len()]
    }

    fn title(&mut self, o: &Spec, e: &Spec) -> Result<(), WriteError> {
        match (&o.title, &e.title) {
            (Some(ot), Some(et)) => {
                if (ot.text.as_str(), ot.id.as_str()) != (et.text.as_str(), et.id.as_str()) {
                    self.replace(ot.span, render_title(&et.text, &et.id));
                }
                Ok(())
            }
            (None, None) => Ok(()),
            _ => Err(WriteError::Unsupported(
                "adding or removing the title".into(),
            )),
        }
    }

    fn diagram(&mut self, o: &Diagram, e: &Diagram) -> Result<(), WriteError> {
        let Some(header) = o.header else {
            return Err(WriteError::Unsupported(
                "editing a diagram without a `flowchart` line".into(),
            ));
        };
        if o.direction != e.direction {
            let Some(dir) = e.direction else {
                return Err(WriteError::Unsupported(
                    "removing the flowchart direction".into(),
                ));
            };
            let indent = self.indent_of(header.span);
            self.replace(header.span, format!("{indent}flowchart {}", dir.as_str()));
        }
        let indent = o
            .nodes
            .first()
            .map(|n| n.span)
            .or(o.edges.first().map(|x| x.span))
            .or(o.clicks.first().map(|x| x.span))
            .or(o.actions.first().map(|x| x.span))
            .map_or("  ", |s| self.indent_of(s))
            .to_string();

        // Nodes, by id.
        for on in &o.nodes {
            match e.nodes.iter().find(|n| n.id == on.id) {
                None => self.delete_line(on.span),
                Some(en) => {
                    let indent = self.indent_of(on.span);
                    self.replace(on.span, format!("{indent}{}", render_node(en)));
                }
            }
        }
        let known: HashSet<&str> = o.nodes.iter().map(|n| n.id.as_str()).collect();
        let new_nodes: Vec<String> = e
            .nodes
            .iter()
            .filter(|n| !known.contains(n.id.as_str()))
            .map(|n| format!("{indent}{}", render_node(n)))
            .collect();
        let after_nodes = o.nodes.last().map_or(header.span.end, |n| n.span.end);
        self.add_group(after_nodes, SEQ_NODE, false, &new_nodes);

        // Edges, clicks and comments, by span.
        let new_edges = self.by_span(&o.edges, &e.edges, |x| x.span, render_edge, &indent);
        let after_edges = o.edges.last().map_or(after_nodes, |x| x.span.end);
        self.add_group(after_edges, SEQ_EDGE, o.edges.is_empty(), &new_edges);

        let new_clicks = self.by_span(&o.clicks, &e.clicks, |x| x.span, render_click, &indent);
        let after_clicks = o.clicks.last().map_or(after_edges, |x| x.span.end);
        self.add_group(after_clicks, SEQ_CLICK, o.clicks.is_empty(), &new_clicks);

        let new_actions = self.by_span(&o.actions, &e.actions, |x| x.span, render_action, &indent);
        let after_actions = o.actions.last().map_or(after_clicks, |x| x.span.end);
        self.add_group(
            after_actions,
            SEQ_ACTION,
            o.actions.is_empty(),
            &new_actions,
        );

        let new_comments = self.by_span(
            &o.comments,
            &e.comments,
            |x| x.span,
            render_comment,
            &indent,
        );
        let mut text = String::new();
        for l in &new_comments {
            text.push_str(l);
            text.push_str(self.nl);
        }
        self.insert(o.body.end, SEQ_COMMENT, text);
        Ok(())
    }

    /// Inserts `lines` after the line holding `pos`, after a blank line when the
    /// group they start is new.
    fn add_group(&mut self, pos: usize, seq: u8, fresh: bool, lines: &[String]) {
        if lines.is_empty() {
            return;
        }
        let mut all = Vec::with_capacity(lines.len() + 1);
        if fresh {
            all.push(String::new());
        }
        all.extend(lines.iter().cloned());
        let (at, text) = self.after_line(pos, &all);
        self.insert(at, seq, text);
    }

    /// Rewrites or deletes the lines of `orig` matched by span in `edited`, and
    /// returns the new elements' lines, indented.
    fn by_span<T>(
        &mut self,
        orig: &[T],
        edited: &[T],
        span: impl Fn(&T) -> Span,
        render: impl Fn(&T) -> String,
        indent: &str,
    ) -> Vec<String> {
        let mut claimed = vec![false; edited.len()];
        for o in orig {
            let s = span(o);
            let hit = edited
                .iter()
                .enumerate()
                .position(|(j, x)| !claimed[j] && span(x) == s);
            match hit {
                Some(j) => {
                    claimed[j] = true;
                    let indent = self.indent_of(s);
                    self.replace(s, format!("{indent}{}", render(&edited[j])));
                }
                None => self.delete_line(s),
            }
        }
        edited
            .iter()
            .zip(claimed)
            .filter(|(_, c)| !c)
            .map(|(x, _)| format!("{indent}{}", render(x)))
            .collect()
    }

    /// Deletes the whole line holding `span`, line ending included.
    fn delete_line(&mut self, span: Span) {
        let end = self.next_line(span.end);
        self.delete(span.start, end);
    }

    fn sections(&mut self, o: &Spec, e: &Spec) {
        for os in &o.sections {
            match e.sections.iter().find(|s| s.id == os.id) {
                None => self.delete(os.span.start, os.span.end),
                Some(es) => self.section(os, es),
            }
        }
    }

    fn section(&mut self, os: &Section, es: &Section) {
        if os.title != es.title {
            self.replace(os.heading, render_heading(&es.title, &es.id));
        }

        // Requirements, by tag. Deleted lines are collected into blocks so a
        // block standing between blank lines takes one of them with it.
        let mut deleted: Vec<(usize, usize)> = Vec::new();
        let mut last_kept: Option<Span> = None;
        for or in &os.requirements {
            match es.requirements.iter().find(|r| r.tag == or.tag) {
                None => deleted.push((or.span.start, self.next_line(or.span.end))),
                Some(er) => {
                    last_kept = Some(or.span);
                    if (or.condition.as_str(), or.response.as_str())
                        != (er.condition.as_str(), er.response.as_str())
                    {
                        self.replace(or.span, render_requirement(er, self.nl));
                    }
                }
            }
        }
        let known: HashSet<&str> = os.requirements.iter().map(|r| r.tag.as_str()).collect();
        let new_reqs: Vec<String> = es
            .requirements
            .iter()
            .filter(|r| !known.contains(r.tag.as_str()))
            .map(|r| render_requirement(r, self.nl))
            .collect();

        let mut new_flow: Option<String> = None;
        match (&os.flow, &es.flow) {
            (Some(oq), Some(eq)) if oq.text != eq.text => self.replace(oq.span, render_flow(eq)),
            (Some(oq), None) => deleted.push((oq.span.start, self.next_line(oq.span.end))),
            (None, Some(eq)) => new_flow = Some(render_flow(eq)),
            _ => {}
        }

        // Where new lines go: after the last kept requirement, else where the
        // first requirement was, else after the heading.
        let (at, mut text, start_of_line) = match (last_kept, os.requirements.first()) {
            (Some(kept), _) => {
                let (at, text) = self.after_line(kept.end, &[]);
                (at, text, false)
            }
            (None, Some(first)) => (first.span.start, String::new(), true),
            (None, None) => {
                let (at, mut text) = self.after_line(os.heading.end, &[]);
                text.push_str(self.nl);
                (at, text, false)
            }
        };
        let inserting = !new_reqs.is_empty() || new_flow.is_some();
        for l in &new_reqs {
            text.push_str(l);
            text.push_str(self.nl);
        }
        if let Some(q) = new_flow {
            // A blank line before the quote, unless it lands where a blank line
            // already is (the first requirement's place, with none added).
            if !(start_of_line && new_reqs.is_empty()) {
                text.push_str(self.nl);
            }
            text.push_str(&q);
            text.push_str(self.nl);
        }
        if inserting {
            let seq = if new_reqs.is_empty() {
                SEQ_FLOW
            } else {
                SEQ_REQ
            };
            self.insert(at, seq, text);
        }

        deleted.sort_unstable();
        let mut blocks: Vec<(usize, usize)> = Vec::new();
        for (s, e) in deleted {
            match blocks.last_mut() {
                Some(b) if b.1 == s => b.1 = e,
                _ => blocks.push((s, e)),
            }
        }
        for (s, mut e) in blocks {
            let fills_gap = inserting && s == at;
            if !fills_gap && self.blank_before(s) && self.blank_at(e) {
                e = self.next_line(e);
            }
            self.delete(s, e);
        }
    }

    /// Applies the patches, restores the source's trailing line endings and
    /// appends new sections.
    fn finish(mut self, o: &Spec, e: &Spec) -> String {
        let known: HashSet<&str> = o.sections.iter().map(|s| s.id.as_str()).collect();
        let new_sections: Vec<&Section> = e
            .sections
            .iter()
            .filter(|s| !known.contains(s.id.as_str()))
            .collect();
        if self.patches.is_empty() && new_sections.is_empty() {
            return self.src.to_string();
        }

        self.patches.sort_by_key(|p| (p.start, p.end, p.seq));
        let mut out = String::with_capacity(self.src.len() + 256);
        let mut at = 0;
        for p in &self.patches {
            // Patches never overlap by construction; skip any that would.
            if p.start < at {
                continue;
            }
            out.push_str(self.src.get(at..p.start).unwrap_or(""));
            out.push_str(&p.text);
            at = p.end;
        }
        out.push_str(self.src.get(at..).unwrap_or(""));

        // A deleted last section can leave blank lines at the end.
        let tail = trailing_newlines(self.src);
        let body_len = out.trim_end_matches(['\n', '\r']).len();
        out.truncate(body_len);
        for _ in 0..tail {
            out.push_str(self.nl);
        }

        for s in new_sections {
            if !out.is_empty() {
                if !out.ends_with('\n') {
                    out.push_str(self.nl);
                }
                if !out.ends_with(&format!("{0}{0}", self.nl)) {
                    out.push_str(self.nl);
                }
            }
            out.push_str(&render_heading(&s.title, &s.id));
            out.push_str(self.nl);
            if !s.requirements.is_empty() {
                out.push_str(self.nl);
                for r in &s.requirements {
                    out.push_str(&render_requirement(r, self.nl));
                    out.push_str(self.nl);
                }
            }
            if let Some(q) = &s.flow {
                out.push_str(self.nl);
                out.push_str(&render_flow(q));
                out.push_str(self.nl);
            }
        }
        out
    }
}

fn trailing_newlines(s: &str) -> usize {
    let body = s.trim_end_matches(['\n', '\r']).len();
    s.get(body..).map_or(0, |tail| tail.matches('\n').count())
}

// ---- Comparing models without positions.

/// What a spec says, without lines and spans, with lists sorted so the
/// writer's placement of new elements does not count as a difference.
#[derive(Debug, PartialEq, Eq)]
struct Shape {
    flow: String,
    title: Option<(String, String)>,
    direction: Option<&'static str>,
    nodes: Vec<(String, String)>,
    edges: Vec<(String, String, String)>,
    clicks: Vec<(String, String)>,
    actions: Vec<(String, String, Option<String>)>,
    comments: Vec<String>,
    sections: Vec<SectionShape>,
}

#[derive(Debug, PartialEq, Eq, PartialOrd, Ord)]
struct SectionShape {
    id: String,
    node: String,
    title: String,
    requirements: Vec<(String, String, String)>,
    flow: Option<String>,
}

impl Shape {
    fn of(spec: &Spec) -> Shape {
        let d = spec.diagram.as_ref();
        let mut nodes: Vec<(String, String)> = d
            .map(|d| {
                d.nodes
                    .iter()
                    .map(|n| (n.id.clone(), n.label.clone()))
                    .collect()
            })
            .unwrap_or_default();
        let mut edges: Vec<(String, String, String)> = d
            .map(|d| {
                d.edges
                    .iter()
                    .map(|e| (e.from.clone(), e.label.clone(), e.to.clone()))
                    .collect()
            })
            .unwrap_or_default();
        let mut clicks: Vec<(String, String)> = d
            .map(|d| {
                d.clicks
                    .iter()
                    .map(|c| (c.node.clone(), c.target.clone()))
                    .collect()
            })
            .unwrap_or_default();
        let mut actions: Vec<(String, String, Option<String>)> = d
            .map(|d| {
                d.actions
                    .iter()
                    .map(|a| (a.node.clone(), a.href.clone(), a.tooltip.clone()))
                    .collect()
            })
            .unwrap_or_default();
        let mut comments: Vec<String> = d
            .map(|d| {
                d.comments
                    .iter()
                    .map(|c| c.text.trim_end().to_string())
                    .collect()
            })
            .unwrap_or_default();
        let mut sections: Vec<SectionShape> = spec
            .sections
            .iter()
            .map(|s| {
                let mut requirements: Vec<(String, String, String)> = s
                    .requirements
                    .iter()
                    .map(|r| (r.tag.clone(), r.condition.clone(), r.response.clone()))
                    .collect();
                requirements.sort();
                SectionShape {
                    id: s.id.clone(),
                    node: s.node.clone(),
                    title: s.title.clone(),
                    requirements,
                    flow: s.flow.as_ref().map(|q| q.text.clone()),
                }
            })
            .collect();
        nodes.sort();
        edges.sort();
        clicks.sort();
        actions.sort();
        comments.sort();
        sections.sort();
        Shape {
            flow: spec.flow.clone(),
            title: spec.title.as_ref().map(|t| (t.text.clone(), t.id.clone())),
            direction: d.and_then(|d| d.direction).map(|x| x.as_str()),
            nodes,
            edges,
            clicks,
            actions,
            comments,
            sections,
        }
    }
}

fn first_difference(want: &Shape, got: &Shape) -> Option<String> {
    if want == got {
        return None;
    }
    let pairs: [(&str, String, String); 9] = [
        (
            "flow",
            format!("{:?}", want.flow),
            format!("{:?}", got.flow),
        ),
        (
            "title",
            format!("{:?}", want.title),
            format!("{:?}", got.title),
        ),
        (
            "direction",
            format!("{:?}", want.direction),
            format!("{:?}", got.direction),
        ),
        (
            "nodes",
            format!("{:?}", want.nodes),
            format!("{:?}", got.nodes),
        ),
        (
            "edges",
            format!("{:?}", want.edges),
            format!("{:?}", got.edges),
        ),
        (
            "clicks",
            format!("{:?}", want.clicks),
            format!("{:?}", got.clicks),
        ),
        (
            "actions",
            format!("{:?}", want.actions),
            format!("{:?}", got.actions),
        ),
        (
            "comments",
            format!("{:?}", want.comments),
            format!("{:?}", got.comments),
        ),
        (
            "sections",
            format!("{:?}", want.sections),
            format!("{:?}", got.sections),
        ),
    ];
    pairs
        .into_iter()
        .find(|(_, a, b)| a != b)
        .map(|(what, a, b)| format!("{what}: wanted {a}, read back {b}"))
        .or_else(|| Some("the models differ".into()))
}
