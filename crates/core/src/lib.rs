//! Spec parsing, spec index, file-to-spec mapping and gate rules.
//! This crate does no I/O so it stays easy to test.

pub mod anchor;
pub mod diag;
pub mod spec;
pub mod write;

/// Crate name, used by the server and runner to report what they are built from.
pub const NAME: &str = "spectrace-core";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn has_a_name() {
        assert_eq!(NAME, "spectrace-core");
    }
}
