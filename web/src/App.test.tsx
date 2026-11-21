import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect, it } from "vitest";
import { App } from "./App";

const at = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );

it("shows the root page without a sidebar", () => {
  at("/projects");
  expect(screen.getByRole("heading", { name: "Projects" })).toBeTruthy();
  expect(screen.queryByText("Quality")).toBeNull();
});

it("shows the sidebar and tab bar inside a project", () => {
  at("/prs");
  expect(screen.getByRole("heading", { name: "Pull requests" })).toBeTruthy();
  expect(screen.getByText("Quality")).toBeTruthy();
  expect(screen.getAllByRole("navigation", { name: "Main" })).toHaveLength(2);
});
