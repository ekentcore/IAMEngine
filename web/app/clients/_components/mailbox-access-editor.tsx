"use client";

// FR #15: the shared mailboxes EVERY new user for this client is granted access to by default, with a
// permission level per mailbox (config.onboard.defaultSharedMailboxes on the m365 system). "Refresh"
// asks the central runner to enumerate the tenant's shared mailboxes (over Exchange Online) so they
// can be picked from a list; an address can also just be typed. The m365 onboard lane applies these.
import { useState } from "react";
import { useRouter } from "next/navigation";

type Access = "FullAccess" | "SendAs" | "SendOnBehalf";
const ACCESS_LABEL: Record<Access, string> = { FullAccess: "Full access", SendAs: "Send as", SendOnBehalf: "Send on behalf" };

type MailboxRow = { address: string; access: Access };
type Discovered = { address: string; displayName?: string };
type Current = { address: string; displayName?: string; access?: string };

const asAccess = (a?: string): Access => (a === "SendAs" || a === "SendOnBehalf" ? a : "FullAccess");

export function MailboxAccessEditor({ slug, current, discovered = [], discoveredMeta }: {
  slug: string;
  current: Current[];
  discovered?: Discovered[];
  discoveredMeta?: { count: number; discoveredAt: string | null };
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<MailboxRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function start() {
    setRows(current.length ? current.map((m) => ({ address: m.address, access: asAccess(m.access) })) : [{ address: "", access: "FullAccess" }]);
    setMsg(null); setOpen(true);
  }

  // Queue a directory discovery: the central runner reads BOTH the tenant's cloud groups and its
  // shared mailboxes in one pass, so this hits the shared cloud-groups endpoint (there's one request
  // flag; a dedicated mailbox route would just be a duplicate of it) and posts the mailboxes back.
  async function refresh() {
    setDiscovering(true); setMsg(null);
    try {
      const r = await fetch(`/api/clients/${slug}/cloud-groups`, { method: "POST" });
      const d = await r.json().catch(() => ({}));
      setMsg(r.ok
        ? { ok: true, text: "✓ Queued — the central runner is reading the tenant's shared mailboxes. Refresh this page in ~30s to see them in the picker." }
        : { ok: false, text: d.error ?? `failed (${r.status})` });
    } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
    finally { setDiscovering(false); }
  }

  const datalistId = `mailbox-options-${slug}`;
  // address -> displayName, so a picked/typed address can show its friendly name.
  const nameByAddress = new Map(discovered.filter((m) => m.address).map((m) => [m.address.toLowerCase(), m.displayName ?? ""]));
  const nameFor = (address: string) => nameByAddress.get(address.trim().toLowerCase()) || (current.find((c) => c.address.toLowerCase() === address.trim().toLowerCase())?.displayName ?? "");

  const refreshBtn = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 8 }}>
      <button style={{ fontSize: 12 }} onClick={refresh} disabled={discovering} title="Have the central runner read this tenant's shared mailboxes over Exchange Online (needs the m365-admin EXO cert)">
        {discovering ? "Queuing…" : "Refresh mailbox list"}
      </button>
      {discoveredMeta && discoveredMeta.count > 0 && (
        <span className="note muted" style={{ fontSize: 11 }}>{discoveredMeta.count} shared mailboxes{discoveredMeta.discoveredAt ? ` · ${new Date(discoveredMeta.discoveredAt).toLocaleDateString()}` : ""}</span>
      )}
    </span>
  );

  if (!open) {
    const summary = current.length
      ? current.map((m) => `${m.displayName || m.address} (${ACCESS_LABEL[asAccess(m.access)]})`).join(", ")
      : "(none set)";
    return (
      <div className="note" style={{ marginTop: "0.4rem" }}>
        Default shared mailbox access: <b>{summary}</b>{" "}
        <button style={{ fontSize: 12, marginLeft: 6 }} onClick={start}>Edit mailboxes</button>
        {refreshBtn}
        {msg && <p className="note" style={{ color: msg.ok ? "#15803d" : "#b91c1c", margin: "4px 0 0" }}>{msg.text}</p>}
      </div>
    );
  }

  const setRow = (i: number, patch: Partial<MailboxRow>) => setRows((r) => r.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: 8, padding: "0.7rem 0.9rem", marginTop: "0.4rem", maxWidth: 620 }}>
      <b style={{ fontSize: 14 }}>Default shared mailbox access</b>
      <p className="note" style={{ margin: "0.2rem 0 0.5rem" }}>Shared mailboxes every new user is granted access to, with the permission level. Pick from the discovered list or type an address (e.g. a shared &ldquo;Global Vacation Calendar&rdquo;).</p>
      <div style={{ margin: "0.2rem 0" }}>{refreshBtn}</div>
      <datalist id={datalistId}>{discovered.filter((m) => m.address).map((m) => <option key={m.address} value={m.address}>{m.displayName ? `${m.displayName} — ${m.address}` : m.address}</option>)}</datalist>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {rows.map((row, i) => (
          <div key={i} style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <span style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
              <input value={row.address} list={datalistId} placeholder="mailbox address" onChange={(e) => setRow(i, { address: e.target.value })} style={{ fontSize: 12 }} />
              {nameFor(row.address) && <span className="note muted" style={{ fontSize: 11 }}>{nameFor(row.address)}</span>}
            </span>
            <select value={row.access} onChange={(e) => setRow(i, { access: e.target.value as Access })} style={{ width: "auto", fontSize: 12 }} title="Permission level granted on this mailbox">
              {(Object.keys(ACCESS_LABEL) as Access[]).map((a) => <option key={a} value={a}>{ACCESS_LABEL[a]}</option>)}
            </select>
            <button style={{ fontSize: 12 }} onClick={() => setRows((r) => r.filter((_, j) => j !== i))} title="Remove">✕</button>
          </div>
        ))}
      </div>
      <button style={{ fontSize: 12, marginTop: 6 }} onClick={() => setRows((r) => [...r, { address: "", access: "FullAccess" }])}>+ Add mailbox</button>
      {msg && <p className="note" style={{ color: msg.ok ? "#15803d" : "#b91c1c", marginTop: 6 }}>{msg.text}</p>}
      <div className="toolbar" style={{ marginTop: 8 }}>
        <button className="primary" disabled={busy} onClick={async () => {
          setBusy(true); setMsg(null);
          try {
            const mailboxes = rows
              .filter((r) => r.address.trim())
              .map((r) => { const dn = nameFor(r.address); return dn ? { address: r.address.trim(), displayName: dn, access: r.access } : { address: r.address.trim(), access: r.access }; });
            const r = await fetch(`/api/clients/${slug}/mailbox-access`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mailboxes }) });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) { setMsg({ ok: false, text: d.error ?? `failed (${r.status})` }); return; }
            setMsg({ ok: true, text: "✓ Saved. Re-plan this client's open cases to apply." });
            router.refresh();
          } catch (e) { setMsg({ ok: false, text: (e as Error).message }); }
          finally { setBusy(false); }
        }}>{busy ? "Saving…" : "Save mailboxes"}</button>
        <button disabled={busy} onClick={() => setOpen(false)}>Close</button>
      </div>
    </div>
  );
}
