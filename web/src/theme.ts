import { useCallback, useState } from "react";

export type Theme = "light" | "dark";
const KEY = "spectrace-theme";

const system = (): Theme =>
  typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";

function stored(): Theme | null {
  try {
    const t = localStorage.getItem(KEY);
    return t === "light" || t === "dark" ? t : null;
  } catch {
    return null;
  }
}

/** Apply a saved choice before first paint so there is no flash. */
export function applyStoredTheme() {
  const t = stored();
  if (t) document.documentElement.setAttribute("data-theme", t);
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => stored() ?? system());
  const toggle = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* private mode: the choice just will not persist */
    }
    setTheme(next);
  }, [theme]);
  return { theme, toggle };
}
