"use client";

// Header 💡 button — file a feature request from any page. Icon-only so the (recently slimmed)
// mobile header stays narrow. Opens a portal dialog (createPortal to <body> — a fixed overlay
// rendered inline can be positioned by a transformed ancestor) with Title + Description; the
// pathname is captured automatically.
import { useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { broadcastFrFiled } from "@/lib/feature-requests/live";

const overlayStyle: React.CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", display: "grid", placeItems: "center", zIndex: 80 };
const cardStyle: React.CSSProperties = { background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 10, padding: "1.1rem 1.3rem", width: "min(460px, calc(100vw - 2rem))", boxShadow: "var(--shadow-2, 0 10px 40px rgba(0,0,0,.3))" };

function Overlay({ onBackdropClick, children }: { onBackdropClick?: () => void; children: React.ReactNode }) {
  return createPortal(
    <div role="dialog" aria-modal="true" style={overlayStyle} onClick={(e) => { if (e.target === e.currentTarget) onBackdropClick?.(); }}>
      <div style={cardStyle}>{children}</div>
    </div>,
    document.body
  );
}

export function FeatureRequestButton() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function close() {
    setOpen(false);
    setSent(false);
    setErr(null);
    if (sent) { setTitle(""); setBody(""); } // keep a draft on plain close; clear after a successful send
  }

  async function submit() {
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/feature-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, body, page: pathname ?? "" }),
      });
      if (!r.ok) {
        const d = (await r.json().catch(() => ({}))) as { error?: string };
        setErr(d.error ?? `failed (${r.status})`);
        return;
      }
      setSent(true);
      broadcastFrFiled(); // bump the nav badge — a new request is always open
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }

  return (
    <>
      <button
        type="button"
        title="Request a feature"
        aria-label="Request a feature"
        onClick={() => setOpen(true)}
        style={{ padding: "0.15rem 0.4rem", fontSize: 14, lineHeight: 1 }}
      >
        💡
      </button>
      {open && (
        <Overlay onBackdropClick={busy ? undefined : close}>
          {sent ? (
            <>
              <h2 style={{ margin: "0 0 0.25rem" }}>Thanks!</h2>
              <p className="note" style={{ marginTop: 0 }}>Your request is in. Track its status (New → Being scripted → Implemented) on the <Link href="/feature-requests" onClick={close}>feature requests</Link> board.</p>
              <div className="toolbar" style={{ justifyContent: "flex-end" }}>
                <button className="primary" onClick={close}>Close</button>
              </div>
            </>
          ) : (
            <>
              <h2 style={{ margin: "0 0 0.25rem" }}>Request a feature</h2>
              <p className="note" style={{ marginTop: 0 }}>What should this app do that it doesn&rsquo;t? Filed from <code>{pathname ?? "/"}</code>. See the <Link href="/feature-requests" onClick={close}>requests board</Link> for status.</p>
              <label style={{ display: "block", marginBottom: "0.6rem" }}>
                <span className="note">Title</span>
                <input
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={200}
                  placeholder="Short summary"
                  style={{ width: "100%" }}
                  autoFocus
                />
              </label>
              <label style={{ display: "block", marginBottom: "0.6rem" }}>
                <span className="note">Description (optional)</span>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  maxLength={5000}
                  rows={4}
                  placeholder="What would it do, and when would you use it?"
                  style={{ width: "100%", resize: "vertical" }}
                />
              </label>
              {err && <p className="note" style={{ color: "#b3261e" }}>{err}</p>}
              <div className="toolbar" style={{ justifyContent: "flex-end", gap: 8 }}>
                <button onClick={close} disabled={busy}>Cancel</button>
                <button className="primary" disabled={busy || title.trim() === ""} onClick={submit}>
                  {busy ? "Sending…" : "Send"}
                </button>
              </div>
            </>
          )}
        </Overlay>
      )}
    </>
  );
}
