// Fixture source for spec anchors. Not compiled: this folder has no Cargo.toml.

#[spec("checkout.cart")]
pub fn start_checkout(cart: &Cart) -> Result<State> {
    /// @flow checkout.cart: re-check stock, cache may be stale
    ensure!(!cart.items.is_empty(), Error::EmptyCart);
    let marked = inventory::mark_out_of_stock(&cart.items);
    Ok(State::Details { cart: marked })
}
