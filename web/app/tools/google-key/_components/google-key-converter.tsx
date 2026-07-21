"use client";

// The interactive half of the Google key converter. Reads a picked JSON key file locally (never
// uploads it), parses it with the SAME seeder the guided create form uses
// (parseGoogleServiceAccountKey), and shows each Automation - API field value. You fill the two the
// key file can't supply — apiURL (the super-admin the service account impersonates) and the optional
// ClientID (customer id) — then "Create Delinea entry" creates the `google-admin` secret in a client's
// Delinea folder (picked from a searchable list) and wires the returned id back onto that client. If
// the client already has a google-admin credential, it asks whether to overwrite it in place or create
// a distinct new one. The key material is used once for that create call and never stored by the app.
import { useEffect, useMemo, useRef, useState } from "react";
import { parseGoogleServiceAccountKey, type SeededFields } from "@/lib/secrets/field-seeders";
import { CopyButton } from "@/app/_components/copy-button";

type Parsed = { values: SeededFields["values"]; note: string };
type ClientItem = { slug: string; name: string; coreId: string | null };
// The create flow's state machine: idle → picking a client → (maybe) resolving a conflict → done/error.
type FlowState =
  | { kind: "idle" }
  | { kind: "picking" }
  | { kind: "working"; slug: string }
  | { kind: "conflict"; client: ClientItem; existsExternalId: string; existsLabel: string | null }
  | { kind: "probeFailed"; client: ClientItem; overwriteExternalId?: string; message: string }
  | { kind: "done"; text: string }
  | { kind: "error"; text: string };

const GOOGLE_ADMIN = "google-admin";

export function GoogleKeyConverter() {
  const [parsed, setParsed] = useState<Parsed | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState(false);
  // The two fields the key file can't supply — the operator types them here.
  const [apiUrl, setApiUrl] = useState("");
  const [clientId, setClientId] = useState("");
  const [flow, setFlow] = useState<FlowState>({ kind: "idle" });

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ""; // let the same (fixed) file re-trigger onChange
    setError(null);
    setParsed(null);
    setReveal(false);
    setFlow({ kind: "idle" });
    if (!file) return;
    try {
      const seeded = parseGoogleServiceAccountKey(await file.text());
      setParsed({ values: seeded.values, note: seeded.note });
    } catch (err) {
      setError((err as Error).message);
    }
  }

  const base64 = parsed?.values.ClientSecret ?? "";
  const accountId = parsed?.values.accountid ?? "";
  const canCreate = Boolean(base64 && accountId && apiUrl.trim());

  // The values POSTed to the create route — keyed by the Automation - API field names.
  const values = useMemo(() => {
    const v: Record<string, string> = { ClientSecret: base64, accountid: accountId, apiURL: apiUrl.trim() };
    if (clientId.trim()) v.ClientID = clientId.trim();
    return v;
  }, [base64, accountId, apiUrl, clientId]);

  // POST to the create route with a given intent. Returns nothing — drives `flow`.
  async function submit(client: ClientItem, opts: { overwriteExternalId?: string; createNew?: boolean; force?: boolean }) {
    setFlow({ kind: "working", slug: client.slug });
    // A distinct label for "create new" so Delinea's name-dedup makes a genuinely separate entry.
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const body: Record<string, unknown> = { name: GOOGLE_ADMIN, values };
    if (opts.overwriteExternalId) body.overwriteExternalId = opts.overwriteExternalId;
    else if (opts.createNew) body.label = `${client.name} — ${GOOGLE_ADMIN} (${stamp})`;
    else body.conflictCheck = true; // first attempt: let the server flag an existing credential
    if (opts.force) body.force = true;

    try {
      const r = await fetch(`/api/clients/${client.slug}/secrets/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json().catch(() => ({}));
      if (r.status === 409 && d.conflict) {
        setFlow({ kind: "conflict", client, existsExternalId: d.existsExternalId, existsLabel: d.existsLabel ?? null });
        return;
      }
      if (r.status === 422 && d.probeFailed) {
        setFlow({ kind: "probeFailed", client, overwriteExternalId: opts.overwriteExternalId, message: [d.error, d.hint].filter(Boolean).join(" — ") });
        return;
      }
      if (!r.ok) {
        setFlow({ kind: "error", text: [d.error, d.hint].filter(Boolean).join(" — ") || `failed (${r.status})` });
        return;
      }
      const verb = d.updated ? "updated" : "saved";
      setFlow({ kind: "done", text: `${verb} ${GOOGLE_ADMIN} on ${client.name} — Delinea id ${d.externalId}, wired to the client.` });
    } catch (e) {
      setFlow({ kind: "error", text: (e as Error).message });
    }
  }

  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ padding: "0.8rem 0.9rem", border: "1px dashed var(--line)", borderRadius: 8, maxWidth: 560 }}>
        <label className="note" style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>
          Choose the downloaded <code>.json</code> key file
        </label>
        <input type="file" accept=".json,application/json" onChange={onFile} />
        <p className="note muted" style={{ fontSize: 12, marginTop: 6, marginBottom: 0 }}>
          From the service account&rsquo;s <b>Keys → Add key → Create new key → JSON</b> in the Google Cloud Console.
        </p>
      </div>

      {error && (
        <p className="note danger" role="alert" style={{ marginTop: 12 }}>✗ {error}</p>
      )}

      {parsed && (
        <div style={{ marginTop: 16 }}>
          <p className="note" style={{ color: "var(--ok-fg)", marginBottom: 12 }}>✓ {parsed.note}</p>
          <p className="note" style={{ marginBottom: 10 }}>
            These make up the <b>google-admin</b> credential (Delinea&rsquo;s <b>Automation - API</b> template). Fill in
            the super-admin email, then create it straight into a client&rsquo;s Delinea folder below.
          </p>

          {/* ClientSecret — the base64 of the whole key file. Masked until revealed (it's key material),
              but always copyable; the copy button works even on plain-HTTP LAN (lib/clipboard fallback). */}
          <Field name="ClientSecret" required desc="base64 of the whole JSON key file (the private key material)">
            <div style={{ display: "flex", gap: 8, alignItems: "flex-start", flexWrap: "wrap" }}>
              <textarea
                readOnly
                value={reveal ? base64 : "•".repeat(Math.min(base64.length, 64))}
                onFocus={(e) => e.currentTarget.select()}
                rows={3}
                style={{ flex: "1 1 320px", minWidth: 260, fontFamily: "var(--mono, monospace)", fontSize: 12, resize: "vertical" }}
              />
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <CopyButton text={base64} label="⧉ copy" />
                <button type="button" style={{ fontSize: 11, padding: "1px 7px" }} onClick={() => setReveal((v) => !v)}>
                  {reveal ? "hide" : "reveal"}
                </button>
              </div>
            </div>
          </Field>

          <Field name="accountid" desc="the service account's own email (client_email) — read from the key file">
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <input
                readOnly
                value={accountId}
                onFocus={(e) => e.currentTarget.select()}
                style={{ flex: "1 1 320px", minWidth: 260, fontFamily: "var(--mono, monospace)", fontSize: 12 }}
              />
              <CopyButton text={accountId} label="⧉ copy" />
            </div>
          </Field>

          <Field name="apiURL" required desc="you supply this — the Workspace super-admin email the service account impersonates (it's an email, not a URL; the stock template has no better field for it)">
            <input
              value={apiUrl}
              onChange={(e) => { setApiUrl(e.target.value); setFlow({ kind: "idle" }); }}
              placeholder="super-admin@clientdomain.com"
              autoComplete="off"
              spellCheck={false}
              style={{ width: "100%", maxWidth: 380, fontFamily: "var(--mono, monospace)", fontSize: 12 }}
            />
          </Field>

          <Field name="ClientID" desc="optional — the Workspace customer ID (Admin Console → Account settings). Leave blank for my_customer">
            <input
              value={clientId}
              onChange={(e) => { setClientId(e.target.value); setFlow({ kind: "idle" }); }}
              placeholder="(optional) e.g. C01ab23cd"
              autoComplete="off"
              spellCheck={false}
              style={{ width: "100%", maxWidth: 380, fontFamily: "var(--mono, monospace)", fontSize: 12 }}
            />
          </Field>

          {/* Create-into-Delinea flow. */}
          <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid var(--line)" }}>
            {flow.kind === "idle" && (
              <>
                <button type="button" className="primary" disabled={!canCreate} onClick={() => setFlow({ kind: "picking" })}>
                  Create Delinea entry →
                </button>
                {!canCreate && (
                  <p className="note muted" style={{ fontSize: 12, marginTop: 6, marginBottom: 0 }}>
                    Fill in <code>apiURL</code> (the super-admin email) to enable this.
                  </p>
                )}
              </>
            )}

            {flow.kind === "picking" && (
              <ClientPicker
                onCancel={() => setFlow({ kind: "idle" })}
                onPick={(client) => submit(client, {})}
              />
            )}

            {flow.kind === "working" && <p className="note">Creating the credential and validating it against Google…</p>}

            {flow.kind === "conflict" && (
              <div style={{ padding: "0.7rem 0.9rem", border: "1px solid var(--warn-line, #d9a441)", borderRadius: 8, maxWidth: 560 }}>
                <p className="note" style={{ margin: "0 0 8px" }}>
                  <b>{flow.client.name}</b> already has a <code>{GOOGLE_ADMIN}</code> credential wired
                  {" "}(Delinea id <code>{flow.existsExternalId}</code>{flow.existsLabel ? ` — ${flow.existsLabel}` : ""}).
                </p>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button type="button" className="primary" onClick={() => submit(flow.client, { overwriteExternalId: flow.existsExternalId })}>
                    Overwrite it (same Delinea id)
                  </button>
                  <button type="button" onClick={() => submit(flow.client, { createNew: true })}>
                    Create a new one
                  </button>
                  <button type="button" onClick={() => setFlow({ kind: "idle" })}>Cancel</button>
                </div>
                <p className="note muted" style={{ fontSize: 12, margin: "8px 0 0" }}>
                  Overwrite updates the existing entry in place. Create new makes a separate entry and re-points the
                  client to it (the old one is left in Delinea).
                </p>
              </div>
            )}

            {flow.kind === "probeFailed" && (
              <div style={{ padding: "0.7rem 0.9rem", border: "1px solid var(--danger-line, #c0524a)", borderRadius: 8, maxWidth: 560 }}>
                <p className="note danger" style={{ margin: "0 0 8px" }}>✗ Google didn&rsquo;t accept the credential: {flow.message}</p>
                <p className="note muted" style={{ fontSize: 12, margin: "0 0 8px" }}>
                  Usually the super-admin email (<code>apiURL</code>) is wrong, or domain-wide delegation isn&rsquo;t
                  granted for this service account yet. Fix it and try again, or save it anyway.
                </p>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button type="button" onClick={() => submit(flow.client, { overwriteExternalId: flow.overwriteExternalId, createNew: !flow.overwriteExternalId, force: true })}>
                    Save anyway
                  </button>
                  <button type="button" onClick={() => setFlow({ kind: "idle" })}>Back</button>
                </div>
              </div>
            )}

            {flow.kind === "done" && (
              <div>
                <p className="note" style={{ color: "var(--ok-fg)" }}>✓ {flow.text}</p>
                <button type="button" onClick={() => setFlow({ kind: "idle" })}>Create another</button>
              </div>
            )}

            {flow.kind === "error" && (
              <div>
                <p className="note danger" role="alert">✗ {flow.text}</p>
                <button type="button" onClick={() => setFlow({ kind: "idle" })}>Back</button>
              </div>
            )}
          </div>

          <p className="note muted" style={{ fontSize: 12, marginTop: 14 }}>
            The key material is used once for the create call and is never stored by the app — reload and it&rsquo;s gone.
            You can still copy the values above and paste them into the guided setup&rsquo;s <b>Create in Delinea</b> form
            instead.
          </p>
        </div>
      )}
    </div>
  );
}

// A searchable single-select client picker: type to filter the scoped client list by name or CoreID.
function ClientPicker({ onPick, onCancel }: { onPick: (c: ClientItem) => void; onCancel: () => void }) {
  const [all, setAll] = useState<ClientItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const r = await fetch("/api/clients");
        if (!r.ok) throw new Error(`couldn't load clients (${r.status})`);
        const data = (await r.json()) as Array<Record<string, unknown>>;
        if (!live) return;
        setAll(
          (Array.isArray(data) ? data : [])
            .map((c) => ({ slug: String(c.slug ?? ""), name: String(c.name ?? ""), coreId: (c.coreId as string) ?? null }))
            .filter((c) => c.slug && c.name),
        );
      } catch (e) {
        if (live) setLoadError((e as Error).message);
      }
    })();
    inputRef.current?.focus();
    return () => { live = false; };
  }, []);

  const matches = useMemo(() => {
    if (!all) return [];
    const q = query.trim().toLowerCase();
    const list = !q
      ? all
      : all.filter((c) => c.name.toLowerCase().includes(q) || (c.coreId ?? "").toLowerCase().includes(q));
    return list.slice(0, 50); // cap the rendered list; refine the search to narrow
  }, [all, query]);

  return (
    <div style={{ padding: "0.7rem 0.9rem", border: "1px solid var(--line)", borderRadius: 8, maxWidth: 560 }}>
      <label className="note" style={{ display: "block", marginBottom: 6, fontWeight: 600 }}>
        Which client is this credential for?
      </label>
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by client name or CoreID…"
        autoComplete="off"
        style={{ width: "100%", maxWidth: 380 }}
      />
      {loadError && <p className="note danger" style={{ marginTop: 8 }}>✗ {loadError}</p>}
      {!all && !loadError && <p className="note muted" style={{ marginTop: 8 }}>Loading clients…</p>}
      {all && (
        <div style={{ marginTop: 8, maxHeight: 260, overflowY: "auto", border: "1px solid var(--line)", borderRadius: 6 }}>
          {matches.length === 0 && <p className="note muted" style={{ padding: "8px 10px", margin: 0 }}>No matching clients.</p>}
          {matches.map((c) => (
            <button
              key={c.slug}
              type="button"
              onClick={() => onPick(c)}
              style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 10px", border: "none", borderBottom: "1px solid var(--line)", background: "transparent", cursor: "pointer" }}
            >
              {c.name}
              {c.coreId && <span className="note muted" style={{ marginLeft: 8, fontSize: 12 }}>{c.coreId}</span>}
            </button>
          ))}
        </div>
      )}
      <div style={{ marginTop: 8 }}>
        <button type="button" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

// One labelled Automation - API field row.
function Field({ name, desc, required, children }: { name: string; desc: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ marginBottom: 3 }}>
        <code style={{ fontSize: 13 }}>{name}</code>
        {required ? <span className="note" style={{ color: "var(--warn-fg)", fontSize: 11, marginLeft: 6 }}>required</span>
          : <span className="note muted" style={{ fontSize: 11, marginLeft: 6 }}>optional</span>}
      </div>
      <div className="note muted" style={{ fontSize: 11, marginBottom: 5 }}>{desc}</div>
      {children}
    </div>
  );
}
