import { render } from "@testing-library/react";
import { expect, test } from "vitest";
import { Markdown as Md } from "./Markdown";


test("renders GitHub's HTML subset and strips unsafe HTML", async () => {
  const { container } = render(
    <Md>{'<details><summary>Release notes</summary><blockquote><h2>v7.18.6</h2><p>See <a href="https://x.test/c">changes</a></p></blockquote></details><script>alert(1)</script><img src=x onerror="alert(1)"><a href="javascript:alert(1)">bad</a>'}</Md>,
  );
  expect(container.querySelector("details > summary")?.textContent).toBe("Release notes");
  expect(container.querySelector("blockquote h2")?.textContent).toBe("v7.18.6");
  expect(container.querySelector("script")).toBeNull();
  expect(container.innerHTML).not.toMatch(/onerror|javascript:/);
});
