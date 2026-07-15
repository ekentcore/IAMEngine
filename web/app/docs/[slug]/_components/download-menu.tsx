"use client";

// Download the current version as Markdown, a self-contained HTML page, or a Word .docx. Plain
// links to the download route — the browser handles the attachment.
import { useEffect, useRef, useState } from "react";

const FORMATS: { format: string; label: string }[] = [
  { format: "docx", label: "Word (.docx)" },
  { format: "html", label: "Web page (.html)" },
  { format: "md", label: "Markdown (.md)" },
];

export function DownloadMenu({ slug, version }: { slug: string; version: string }) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  return (
    <div ref={wrap} style={{ position: "relative" }}>
      <button type="button" className="btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        Download <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div role="menu" style={{ position: "absolute", right: 0, top: "calc(100% + 4px)", zIndex: 20, background: "var(--bg, #fff)", border: "1px solid var(--line, #e5e7eb)", borderRadius: 8, minWidth: 180, boxShadow: "0 6px 20px rgba(0,0,0,0.12)" }}>
          <div className="note" style={{ padding: "8px 12px 4px", fontSize: 12 }}>Version {version}</div>
          {FORMATS.map((f) => (
            <a
              key={f.format}
              role="menuitem"
              href={`/api/docs/${slug}/download?format=${f.format}`}
              className="nav-menu-item"
              style={{ display: "block", padding: "8px 12px" }}
              onClick={() => setOpen(false)}
            >
              {f.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}
