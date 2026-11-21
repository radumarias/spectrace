// Fixture tests for spec anchors. Not compiled: this folder has no Cargo.toml.
// A #[spec] on a function that is also a test marks coverage of that requirement.

#[test]
#[spec("checkout.cart/r1")]
fn cart_empty_disables_checkout() {}

#[test]
#[spec("checkout.cart/r2")]
fn out_of_stock_is_marked() {}

#[test]
#[spec("checkout.pay/r1")]
fn charges_once() {}

#[test]
#[spec("checkout.pay/r2")]
fn timeout_is_idempotent() {}

#[test]
#[spec("checkout.paid/r1")]
fn receipt_sent_from_outbox() {}

#[test]
#[spec("checkout.failed/r1")]
fn shows_decline_reason() {}

#[test]
#[spec("checkout.failed/r2")]
fn retry_limit_is_3() {}

// Deliberately absent: checkout.details/r1 and r2 have no test, so the fixture
// shows "no test" in coverage, as in the prototype.
