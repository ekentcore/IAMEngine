"use client";

import { useState } from "react";
import { isEmail, isAttachment, type Artifact, type EmailArtifact, type AttachmentArtifact } from "@/lib/runbook/artifacts";

export type RunbookItemVM = {
  id: string; // `${action}-${seq}`
  action: "onboard" | "offboard";
  seq: number;
  status: string; // automated | manual | unmodeled
  systemKey: string | null;
  title: string;
  guess: string | null;
  steps: string[];
  after: string[]; // dependency system keys present in this action
  kbHref: string | null;
  kbNum: string | null;
  code: string | null; // intended-automation PowerShell preview
  artifacts: Artifact[]; // email templates / linked files
  // A system that RUNS in this lane but has no section in the KB doc (wired in the systems editor
  // or a profile, e.g. a runbook that came from a script rather than an article). It executes on a
  // real case, so the runbook must show it rather than pretend the doc is the whole procedure.
  unlisted?: boolean;
  when?: string | null; // non-"always" lane gate, e.g. "on request" / "by persona"
};

export function RunbookView({ items, slug }: { items: RunbookItemVM[]; slug: string }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const setAll = (ids: string[], on: boolean) =>
    setOpen((s) => { const n = new Set(s); ids.forEach((id) => (on ? n.add(id) : n.delete(id))); return n; });

  return (
    <>
      {(["onboard", "offboard"] as const).map((action) => {
        const group = items.filter((i) => i.action === action);
        if (group.length === 0) return null;
        const ids = group.map((i) => i.id);
        const auto = group.filter((i) => i.status === "automated").length;
        const kb = group.find((i) => i.kbHref);
        return (
          <div key={action} style={{ marginTop: "1rem" }}>
            <div className="row-between" style={{ alignItems: "baseline" }}>
              <h3 style={{ margin: 0 }}>{action === "onboard" ? "Onboard" : "Offboard"}</h3>
              <div className="toolbar">
                {kb?.kbHref && (
                  <a href={kb.kbHref} target="_blank" rel="noreferrer" className="note">KB article {kb.kbNum} →</a>
                )}
                <button onClick={() => setAll(ids, true)}>Expand all</button>
                <button onClick={() => setAll(ids, false)}>Collapse all</button>
              </div>
            </div>
            <p className="note" style={{ marginTop: 0 }}>
              {group.length} steps — {auto} automated, {group.length - auto} human interaction
            </p>
            {group.map((it, idx) => (
              <Item key={it.id} it={it} n={idx + 1} slug={slug} open={open.has(it.id)} onToggle={() => toggle(it.id)} />
            ))}
          </div>
        );
      })}
    </>
  );
}

function Item({ it, n, slug, open, onToggle }: { it: RunbookItemVM; n: number; slug: string; open: boolean; onToggle: () => void }) {
  const auto = it.status === "automated";
  const emails = it.artifacts.filter(isEmail);
  const attachments = it.artifacts.filter(isAttachment);
  const badge = auto ? "✅ Automated" : it.status === "manual" ? "✋ Human · manual" : "✋ Human · needs module";
  const title = it.systemKey ? `${it.systemKey} — ${it.title}` : it.guess ? `${it.title} (${it.guess})` : it.title;
  return (
    <details open={open} style={{ margin: "0.2rem 0" }}>
      <summary onClick={(e) => { e.preventDefault(); onToggle(); }} style={{ cursor: "pointer" }}>
        <strong style={{ marginRight: 6 }}>{n}.</strong>
        <span className={`badge ${auto ? "automated" : "human"}`}>{badge}</span> {title}
        {emails.length > 0 && <span className="note" style={{ marginLeft: 6 }}>· ✉ email</span>}
        {attachments.length > 0 && <span className="note" style={{ marginLeft: 6 }}>· 📎 file</span>}
        {it.when && <span className="note" style={{ marginLeft: 6 }}>· {it.when}</span>}
        {it.after.length > 0 && <span className="note" style={{ marginLeft: 6 }}>· after: {it.after.join(", ")}</span>}
        {it.unlisted && <span className="note" style={{ marginLeft: 6 }}>· not in the KB doc</span>}
      </summary>
      <div style={{ margin: "0.4rem 0 0.6rem" }}>
        {it.unlisted ? (
          <p className="note" style={{ marginLeft: "1rem" }}>
            Modeled in the systems editor, not written up in the KB article — it still runs on every case.
            Add a section to the runbook to document it.
          </p>
        ) : it.steps.length === 0 ? (
          <p className="note" style={{ marginLeft: "1rem" }}>(no step text — see the KB article)</p>
        ) : (
          it.steps.map((step, i) => {
            const indent = step.match(/^ */)?.[0].length ?? 0;
            return <div key={i} className="muted" style={{ marginLeft: `${0.8 + indent * 0.6}rem` }}>• {step.trim()}</div>;
          })
        )}
        {it.code && (
          <div style={{ marginTop: "0.5rem", marginLeft: "0.8rem" }}>
            <div className="note">Intended automation (PowerShell):</div>
            <pre style={{ background: "#f6f8fa", border: "1px solid #e5e7eb", borderRadius: 4, padding: "0.6rem", overflowX: "auto", fontSize: 11, lineHeight: 1.45, margin: "0.25rem 0 0" }}>
              <code>{it.code}</code>
            </pre>
          </div>
        )}
        {emails.map((em, i) => (
          <EmailBlock
            key={i}
            email={em}
            href={`/api/clients/${slug}/runbook/email?action=${it.action}&seq=${it.seq}&i=${i}`}
          />
        ))}
        {attachments.map((att, i) => (
          <AttachmentBlock key={i} att={att} slug={slug} action={it.action} seq={it.seq} i={i} />
        ))}
      </div>
    </details>
  );
}

function EmailBlock({ email, href }: { email: EmailArtifact; href: string }) {
  const Row = ({ label, value }: { label: string; value: string }) =>
    value ? (
      <div>
        <span className="note">{label}: </span>
        {value}
      </div>
    ) : null;
  return (
    <div style={{ marginTop: "0.5rem", marginLeft: "0.8rem" }}>
      <div className="row-between" style={{ alignItems: "baseline" }}>
        <div className="note">✉ Email template (helpdesk):</div>
        <a href={href} download className="note">download .eml →</a>
      </div>
      <div style={{ background: "#f6f8fa", border: "1px solid #e5e7eb", borderRadius: 4, padding: "0.6rem", margin: "0.25rem 0 0", fontSize: 12 }}>
        <Row label="To" value={(email.to ?? []).join(", ")} />
        <Row label="Cc" value={(email.cc ?? []).join(", ")} />
        <Row label="Subject" value={email.subject} />
        {email.fields && email.fields.length > 0 && (
          <div style={{ marginTop: "0.3rem" }}>
            <span className="note">Fields (filled from the UM case): </span>
            {email.fields.join(", ")}
          </div>
        )}
        <pre style={{ whiteSpace: "pre-wrap", margin: "0.4rem 0 0", fontSize: 11, lineHeight: 1.45, fontFamily: "inherit" }}>{email.body}</pre>
      </div>
    </div>
  );
}

type ResolveResult = {
  resolution?: { groups: string[]; unverified: string[]; reasoning: string; lowConfidence: boolean };
  sheet?: { headers: string[]; rowCount: number; filename?: string };
  error?: string;
};

function AttachmentBlock({
  att, slug, action, seq, i,
}: { att: AttachmentArtifact; slug: string; action: "onboard" | "offboard"; seq: number; i: number }) {
  const [user, setUser] = useState({ department: "", jobTitle: "", location: "" });
  const [state, setState] = useState<"idle" | "loading">("idle");
  const [result, setResult] = useState<ResolveResult | null>(null);

  async function resolve() {
    setState("loading");
    setResult(null);
    try {
      const res = await fetch(`/api/clients/${slug}/runbook/attachment/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, seq, i, user }),
      });
      setResult((await res.json()) as ResolveResult);
    } catch (e) {
      setResult({ error: (e as Error).message });
    } finally {
      setState("idle");
    }
  }

  const input = (key: keyof typeof user, ph: string) => (
    <input
      value={user[key]}
      placeholder={ph}
      onChange={(e) => setUser((u) => ({ ...u, [key]: e.target.value }))}
      style={{ fontSize: 12, padding: "2px 6px", border: "1px solid #e5e7eb", borderRadius: 4, width: 130 }}
    />
  );

  return (
    <div style={{ marginTop: "0.5rem", marginLeft: "0.8rem" }}>
      <div className="row-between" style={{ alignItems: "baseline" }}>
        <div className="note">📎 Attachment: {att.filename || "file"}</div>
        {att.href && <a href={att.href} target="_blank" rel="noreferrer" className="note">open in ServiceNow →</a>}
      </div>
      <div style={{ background: "#f6f8fa", border: "1px solid #e5e7eb", borderRadius: 4, padding: "0.6rem", margin: "0.25rem 0 0", fontSize: 12 }}>
        <div className="note" style={{ marginBottom: 4 }}>Resolve groups for a user (filled from the UM case later):</div>
        <div className="toolbar" style={{ gap: 6, flexWrap: "wrap" }}>
          {input("department", "Department")}
          {input("jobTitle", "Title")}
          {input("location", "Location")}
          <button onClick={resolve} disabled={state === "loading"}>
            {state === "loading" ? "Resolving…" : "Resolve groups"}
          </button>
        </div>
        {result?.error && <div style={{ color: "#b91c1c", marginTop: 6 }}>{result.error}</div>}
        {result?.resolution && (
          <div style={{ marginTop: 6 }}>
            <div>
              <span className="note">Groups: </span>
              {result.resolution.groups.length ? result.resolution.groups.join(", ") : "—"}
              {result.resolution.lowConfidence && <span className="note"> (low confidence — verify)</span>}
            </div>
            {result.resolution.unverified.length > 0 && (
              <div className="note">Suggested but not in the sheet: {result.resolution.unverified.join(", ")}</div>
            )}
            {result.resolution.reasoning && <div className="note">{result.resolution.reasoning}</div>}
          </div>
        )}
      </div>
    </div>
  );
}
