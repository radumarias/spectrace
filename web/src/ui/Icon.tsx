const PATHS = {
  home: "M3 11l9-7 9 7v9H3z M9 20v-6h6v6",
  map: "M12 9.5a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z M4.5 3a2 2 0 1 0 0 4a2 2 0 1 0 0-4z M19.5 3a2 2 0 1 0 0 4a2 2 0 1 0 0-4z M4.5 17a2 2 0 1 0 0 4a2 2 0 1 0 0-4z M19.5 17a2 2 0 1 0 0 4a2 2 0 1 0 0-4z M6 6.5l4.3 4M18 6.5l-4.3 4M6 17.5l4.3-4M18 17.5l-4.3-4",
  spec: "M4.5 9h3a1.5 1.5 0 0 1 1.5 1.5v3A1.5 1.5 0 0 1 7.5 15h-3A1.5 1.5 0 0 1 3 13.5v-3A1.5 1.5 0 0 1 4.5 9z M16.5 3h3A1.5 1.5 0 0 1 21 4.5v3A1.5 1.5 0 0 1 19.5 9h-3A1.5 1.5 0 0 1 15 7.5v-3A1.5 1.5 0 0 1 16.5 3z M16.5 15h3a1.5 1.5 0 0 1 1.5 1.5v3a1.5 1.5 0 0 1-1.5 1.5h-3a1.5 1.5 0 0 1-1.5-1.5v-3a1.5 1.5 0 0 1 1.5-1.5z M9 12h3v-6h3M12 12v6h3",
  prs: "M6 3a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4z M6 16.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4z M18 16.8a2.2 2.2 0 1 0 0 4.4a2.2 2.2 0 1 0 0-4.4z M6 7.2v9.6M18 16.8V10a3 3 0 0 0-3-3h-4 M13 4.5L10.5 7 13 9.5",
  agents: "M7 7h10a3 3 0 0 1 3 3v6a3 3 0 0 1-3 3H7a3 3 0 0 1-3-3v-6a3 3 0 0 1 3-3z M12 3v4M9 12h.01M15 12h.01M9.5 16h5",
  risk: "M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z M12 8v5M12 16h.01",
  runners: "M5 4h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M5 13h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2z M7 7.5h.01M7 16.5h.01",
  project: "M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1",
  back: "M15 5l-7 7 7 7",
  talk: "M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z M5 11a7 7 0 0 0 14 0M12 18v3",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
