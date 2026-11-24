import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { Inline } from "./Inline";

it("renders `code` and **bold**, and leaves everything else as text", () => {
  const { container } = render(<p><Inline>{"Calls `pay(o)` **twice** on <b>retry</b>, `a**b**`"}</Inline></p>);
  const codes = [...container.querySelectorAll("code")].map((c) => c.textContent);
  expect(codes).toEqual(["pay(o)", "a**b**"]);
  expect(container.querySelector("b")?.textContent).toBe("twice");
  expect(container.textContent).toContain("<b>retry</b>");
});
