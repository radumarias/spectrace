import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { App } from "./App";

it("renders the title", () => {
  render(<App />);
  expect(screen.getByText("spectrace")).toBeTruthy();
});
