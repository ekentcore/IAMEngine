"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

export function AddClientDialog() {
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
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
      if (!res.ok) {
        setError(data.error ?? res.statusText);
      } else {
        ref.current?.close();
        router.refresh();
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button onClick={() => ref.current?.showModal()}>Add client</button>
      <dialog ref={ref}>
        <form onSubmit={submit}>
          <h2>Add client</h2>
          <p className="note">Onboard a client. Systems are attached later via a profile.</p>

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

          {error && <p className="note" style={{ color: "#9a3a3a" }}>{error}</p>}

          <div className="toolbar" style={{ marginTop: "1rem", justifyContent: "flex-end" }}>
            <button type="button" onClick={() => ref.current?.close()} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="primary" disabled={busy}>
              {busy ? "Adding…" : "Add client"}
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}
