"use client";

// FR #83/#107: let an operator set the AD domain for an ad-standalone client whose on-prem
// namespace differs from its mail domain (real case: core2187 Olympus - LittleRock - YEE, AD
// syee.local, mail olympuscosmetic.com). PATCHes the existing client route's set-ad-domain
// action, which MERGES the value into identity.adDomain rather than replacing the identity blob
// — see lib/profiles/ad-domain.ts's mergeAdDomain. A blank value clears the field.
import { useState } from "react";
import { useRouter } from "next/navigation";

export function AdDomainEditor({ slug, initial }: { slug: string; initial: string }) {
  const router = useRouter();
  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/clients/${slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "set-ad-domain", domain: value }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        setErr(d.error ?? `failed (${r.status})`);
        return;
      }
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: 6 }}>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
        AD domain (standalone only)
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. syee.local"
          style={{ width: 220, fontSize: 12.5 }}
        />
        <button disabled={busy || value.trim() === initial.trim()} onClick={() => void save()}>
          {busy ? "Saving…" : "Save"}
        </button>
      </label>
      <p className="note" style={{ margin: "2px 0 0" }}>
        Set this only when on-prem AD uses a different namespace from email — e.g. AD{" "}
        <code>syee.local</code>, mail <code>olympuscosmetic.com</code>. Leave blank otherwise.
      </p>
      {err && <p className="note" style={{ color: "#b91c1c" }}>{err}</p>}
    </div>
  );
}
