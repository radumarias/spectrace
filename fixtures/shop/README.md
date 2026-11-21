# fixtures/shop

The prototype's checkout flow, used as the test subject for specs, reviews and coverage.
Format: [docs/spec-format.md](../../docs/spec-format.md). Nothing here is compiled.

| Path | What it is |
|---|---|
| `spec/checkout.md` | The flow as merged: cart, details, pay, paid, declined. Retry limit 3. |
| `proposed/checkout-with-refunds.md` | The same flow with the refund step PR #142 adds. Diff it against `spec/checkout.md` to test spec-change review. |
| `src/` | Rust with `#[spec]` and `@flow` anchors. |
| `tests/checkout.rs` | Tests anchored to requirements. `checkout.details` has none on purpose. |
