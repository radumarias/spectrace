import type { IconName } from "../ui/Icon";

export type NavItem = { id: IconName; label: string; badge?: number };

/** Sidebar groups, in the prototype's order. */
export const GROUPS: { title: string; items: NavItem[] }[] = [
  { title: "Work", items: [{ id: "home", label: "Home" }, { id: "prs", label: "Pull requests" }, { id: "map", label: "App map" }, { id: "spec", label: "Spec" }, { id: "board", label: "Whiteboard" }] },
  { title: "Quality", items: [{ id: "agents", label: "Agents" }, { id: "risk", label: "Coverage + risk" }] },
  { title: "Setup", items: [{ id: "project", label: "Project settings" }, { id: "runners", label: "Runners" }, { id: "talk", label: "Talk" }] },
];

/** Bottom tab bar on phones; secondary pages light up their parent tab. */
export const TABS: { id: IconName; label: string; also?: string[] }[] = [
  { id: "home", label: "Home", also: ["project"] },
  { id: "prs", label: "PRs", also: ["pr"] },
  { id: "spec", label: "Spec", also: ["map", "board"] },
  { id: "agents", label: "Agents", also: ["risk", "runners"] },
  { id: "talk", label: "Talk" },
];

/** Pages that live outside a project: no sidebar, no tab bar. */
export const ROOT_ROUTES = ["projects", "new-project"];

export const TITLES: Record<string, string> = {
  projects: "Projects",
  "new-project": "New project",
  home: "Home",
  prs: "Pull requests",
  map: "App map",
  spec: "Spec",
  board: "Whiteboard",
  agents: "Agents",
  risk: "Coverage + risk",
  project: "Project settings",
  runners: "Runners",
  talk: "Talk",
};
