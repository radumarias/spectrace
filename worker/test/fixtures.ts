// The fixture repository (fixtures/shop), read at build time so tests in
// workerd need no file system.
import checkoutSpec from "../../fixtures/shop/spec/checkout.md?raw";
import cartSrc from "../../fixtures/shop/src/cart.rs?raw";
import checkoutSrc from "../../fixtures/shop/src/checkout.rs?raw";
import checkoutTests from "../../fixtures/shop/tests/checkout.rs?raw";

/** fixtures/shop as repository files, at the paths a real repo would have them. */
export const SHOP: Record<string, string> = {
  "spec/checkout.md": checkoutSpec,
  "src/cart.rs": cartSrc,
  "src/checkout.rs": checkoutSrc,
  "tests/checkout.rs": checkoutTests,
};
