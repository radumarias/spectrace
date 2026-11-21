// Fixture source for spec anchors. Not compiled: this folder has no Cargo.toml.

const MAX_RETRIES: u8 = 3;

#[spec("checkout.details")]
pub fn collect_details(o: &mut Order, form: Form) -> Result<State> {
    let addr = Address::parse(&form.address).map_err(|e| Error::Field(e.field))?;
    o.address = Some(addr);
    Ok(State::Paying)
}

#[spec("checkout.pay")]
pub async fn pay(o: &mut Order) -> Result<State> {
    // @flow checkout.pay: one idempotency key per order
    let key = o.idempotency_key();
    match gateway::charge(o.total, &key).await? {
        Charge::Ok(id) => {
            o.charge_id = Some(id);
            Ok(State::Paid)
        }
        Charge::Declined(why) => Ok(on_declined(o, why)),
    }
}

#[spec("checkout.paid")]
pub fn on_paid(o: &mut Order) -> State {
    outbox::push(Email::Receipt(o.id));
    o.paid_at = Some(Utc::now());
    State::Paid
}

#[spec("checkout.failed")]
pub fn on_declined(o: &mut Order, why: Decline) -> State {
    // @flow checkout.failed: cap retries, then cancel
    o.retries += 1;
    if o.retries > MAX_RETRIES {
        return State::Cancelled { reason: why };
    }
    State::Declined { reason: why }
}
