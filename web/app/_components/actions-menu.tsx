"use client";

// Shared per-row "Actions ▾" popover (v2 tables): every row action behind one compact trigger
// instead of an always-visible button row. Self-contained — manages its own open state and
// click-away, so callers just pass the items.
import { useEffect, useRef, useState } from "react";

export type ActionsMenuItem = {
  label: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
};

export function ActionsMenu({ label = "Actions", items }: { label?: string; items: ActionsMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button className="actions-trigger" aria-haspopup="menu" aria-expanded={open}
        onClick={() => setOpen((o) => !o)}>{label}&nbsp;▾</button>
      {open && (
        <div role="menu" className="actions-menu">
          {items.map((it, i) => (
            <button key={i} className={it.danger ? "danger" : undefined} disabled={it.disabled} title={it.title}
              onClick={() => { setOpen(false); it.onClick(); }}>
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
