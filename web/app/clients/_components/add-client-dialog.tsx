"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

// One or many CORE ids in, clients out: each is resolved in ServiceNow, created, and built out from
// its KB runbooks (sections + the systems those imply). Results stream back a row at a time — a
// build is a couple of KB fetches plus AI extraction per client, so a batch takes minutes and the
// operator needs to see it moving. A single successful import lands you on that client's page; a
// batch leaves the summary table up.
//
// The manual name/domain form is still here, behind a disclosure, for clients that aren't in
// ServiceNow at all.

type Built = { action: "onboard" | "offboard"; kb: string; title: string; sections: number; confident: boolean };
type ImportRow = {
  coreId: string;
  status: "imported" | "exists" | "not_found" | "invalid" | "error";
  slug?: string;
  name?: string;
  built: Built[];
  createdSystems: string[];
  warnings: string[];
  error?: string;
};

const STATUS_BADGE: Record<ImportRow["status"], string> = {
  imported: "badge active",
  exists: "badge modeled",
  not_found: "badge archived",
  invalid: "badge archived",
  error: "badge archived",
};

const STATUS_LABEL: Record<ImportRow["status"], string> = {
  imported: "Imported",
  exists: "Already in the system",
  not_found: "Not in ServiceNow",
  invalid: "Not a CORE id",
  error: "Failed",
};

export function AddClientDialog() {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [total, setTotal] = useState(0);

  function close() {
    ref.current?.close();
    // Anything imported changes the list behind the dialog.
    if (rows.some((r) => r.status === "imported")) router.refresh();
    setRows([]);
    setTotal(0);
    setError(null);
  }

  async function importIds(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const coreIds = String(new FormData(e.currentTarget).get("coreIds") ?? "").trim();
    if (!coreIds) return;

    setBusy(true);
    setError(null);
    setRows([]);
    // Rough count for the "n/total" progress line. The server decides what it actually processes
    // (it de-duplicates), so once the two disagree the row count is the truth.
    setTotal(coreIds.split(/[,;\s]+/).filter(Boolean).length);

    const collected: ImportRow[] = [];
    try {
      const res = await fetch("/api/clients/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ coreIds }),
      });

      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? res.statusText);
        return;
      }

      // NDJSON: one result per line, rendered the moment it lands.
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? ""; // a chunk can split mid-line
        for (const l of lines) {
          if (!l.trim()) continue;
          collected.push(JSON.parse(l) as ImportRow);
          setRows([...collected]);
        }
      }

      // One id, one new client: go look at it. Anything else keeps the summary on screen.
      const only = collected.length === 1 ? collected[0] : null;
      if (only?.status === "imported" && only.slug) {
        ref.current?.close();
        router.push(`/clients/${only.slug}`);
        return;
      }
      if (collected.some((r) => r.status === "imported")) router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function addManually(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(e.currentTarget);
    const payload = {
      name: String(form.get("name") ?? "").trim(),
      primaryDomain: String(form.get("primaryDomain") ?? "").trim(),
      backbone: String(form.get("backbone") ?? "") || undefined,
      coreId: String(form.get("coreId") ?? "").trim() || undefined,
    };
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) setError(data.error ?? res.statusText);
      else {
        ref.current?.close();
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  const done = rows.length;
  const showResults = rows.length > 0;

  return (
    <>
      <button onClick={() => ref.current?.showModal()}>Add client</button>
      <dialog ref={ref} style={showResults ? { width: "min(760px, 94vw)" } : undefined}>
        <h2>Add clients</h2>
        <p className="note">
          Paste one CORE id or several, separated by commas. Each is looked up in ServiceNow, created, and built out
          from its onboarding and offboarding KB articles.
        </p>

        <form onSubmit={importIds}>
          <label htmlFor="coreIds">CORE ids</label>
          <textarea
            id="coreIds"
            name="coreIds"
            rows={2}
            placeholder="CORE1269, CORE832, 1453"
            style={{ width: "100%", fontFamily: "inherit" }}
            disabled={busy}
          />
          <div className="toolbar" style={{ marginTop: "0.75rem", justifyContent: "flex-end" }}>
            <button type="button" onClick={close} disabled={busy}>
              {showResults ? "Done" : "Cancel"}
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? `Importing… ${done}/${Math.max(total, done)}` : "Import"}
            </button>
          </div>
        </form>

        {error && <p className="note danger">{error}</p>}

        {showResults && (
          <div style={{ marginTop: "1rem", maxHeight: "50vh", overflowY: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>CORE id</th>
                  <th>Client</th>
                  <th>Result</th>
                  <th>Built</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.coreId}>
                    <td>{r.coreId}</td>
                    <td>{r.slug ? <a href={`/clients/${r.slug}`}>{r.name ?? r.slug}</a> : <span className="muted">—</span>}</td>
                    <td>
                      <span className={STATUS_BADGE[r.status]}>{STATUS_LABEL[r.status]}</span>
                      {/* The badge already says it for invalid/not_found — only a real failure has
                          anything to add. */}
                      {r.error && r.status === "error" && <div className="note danger">{r.error}</div>}
                      {r.warnings.map((w) => (
                        <div key={w} className="note">
                          {w}
                        </div>
                      ))}
                    </td>
                    <td>
                      {r.built.length === 0 ? (
                        <span className="muted">—</span>
                      ) : (
                        r.built.map((b) => (
                          <div key={b.action} className="note">
                            {b.action}: {b.kb} · {b.sections} section{b.sections === 1 ? "" : "s"}
                            {!b.confident && " ⚠"}
                          </div>
                        ))
                      )}
                      {r.createdSystems.length > 0 && (
                        <div className="note">
                          {r.createdSystems.length} system{r.createdSystems.length === 1 ? "" : "s"}:{" "}
                          {r.createdSystems.join(", ")}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <details style={{ marginTop: "1rem" }}>
          <summary className="note">Add manually (a client that isn&apos;t in ServiceNow)</summary>
          <form onSubmit={addManually} style={{ marginTop: "0.75rem" }}>
            <label htmlFor="name">Name</label>
            <input id="name" name="name" required />

            <label htmlFor="primaryDomain">Primary domain</label>
            <input id="primaryDomain" name="primaryDomain" placeholder="example.com" required />

            <label htmlFor="coreId">CORE id (optional)</label>
            <input id="coreId" name="coreId" placeholder="CORE1234" />

            <label htmlFor="backbone">Backbone (optional)</label>
            <select id="backbone" name="backbone" defaultValue="">
              <option value="">— not modeled —</option>
              <option value="entra">Entra</option>
              <option value="google">Google</option>
              <option value="ad_synced">AD synced</option>
              <option value="ad_standalone">AD standalone</option>
            </select>

            <div className="toolbar" style={{ marginTop: "1rem", justifyContent: "flex-end" }}>
              <button type="submit" disabled={busy}>
                {busy ? "Adding…" : "Add client"}
              </button>
            </div>
          </form>
        </details>
      </dialog>
    </>
  );
}
