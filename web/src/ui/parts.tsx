import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "ghost";
  small?: boolean;
};

export function Button({ variant = "default", small, className, ...rest }: ButtonProps) {
  const cls = ["btn", variant === "primary" && "pri", variant === "ghost" && "ghost", small && "sm", className]
    .filter(Boolean)
    .join(" ");
  return <button type="button" className={cls} {...rest} />;
}

export type PillTone = "ok" | "bad" | "warn" | "idle" | "acc";

export function Pill({ tone = "idle", children }: { tone?: PillTone; children: ReactNode }) {
  return <span className={`pill p-${tone}`}>{children}</span>;
}

export function Card({ pad = true, className, children }: { pad?: boolean; className?: string; children: ReactNode }) {
  return <div className={["card", pad && "pad", className].filter(Boolean).join(" ")}>{children}</div>;
}

export type TabItem = { id: string; label: string };

export function Tabs({ items, value, onChange }: { items: TabItem[]; value: string; onChange: (id: string) => void }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={t.id === value}
          className={t.id === value ? "on" : undefined}
          onClick={() => onChange(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function PageHead({ eyebrow, title, sub, children }: { eyebrow?: string; title: string; sub?: string; children?: ReactNode }) {
  return (
    <div className="head">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {sub && <p className="sub">{sub}</p>}
      </div>
      {children && <div className="btns" style={{ flexDirection: "row", alignItems: "center" }}>{children}</div>}
    </div>
  );
}
