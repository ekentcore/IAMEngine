"use client";

// The floating email/UPN name-format editor (Primary + optional conflict Backup, live "John Jason
// Doe" preview). Rendered inside the cell it edits; the caller positions it and supplies the save
// callback. Shared by ClientsTable (v1) and ClientsExplorer (v2).
//
// Callers must render <UsernamePatternDatalist /> once per page for the input suggestions.
import { useState } from "react";
import { formatPreview } from "./client-vm";

export function UsernamePatternDatalist() {
  return (
    <datalist id="username-patterns">
      <option value="{first}.{last}">first.last</option>
      <option value="{f}{last}">flast</option>
      <option value="{first}{l}">firstl</option>
      <option value="{first}_{last}">first_last</option>
      <option value="{first}-{last}">first-last</option>
      <option value="{last}.{first}">last.first</option>
      <option value="{first}">first</option>
    </datalist>
  );
}

export function EmailFormatEditor({
  currentPattern,
  domain,
  saving,
  onSave,
  onClose,
}: {
  currentPattern: string;
  domain: string | null;
  saving: boolean;
  // Receives the combined "primary | backup" pattern; only called when it actually changed.
  onSave: (pattern: string) => void;
  onClose: () => void;
}) {
  const parts = currentPattern.split("|").map((s) => s.trim());
  const [draft, setDraft] = useState(parts[0] ?? "");
  const [draftBackup, setDraftBackup] = useState(parts.slice(1).join(" | "));

  // Commit: combine Primary + optional Backup into "primary | backup" (the route splits on "|";
  // the backup is used when the primary UPN is already taken by someone else).
  function commit() {
    const combined = draft.trim() + (draftBackup.trim() ? ` | ${draftBackup.trim()}` : "");
    if (draft.trim() && combined !== currentPattern) onSave(combined);
    else onClose();
  }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") commit();
    else if (e.key === "Escape") onClose();
  };

  return (
    <div
      // Save when focus leaves the whole editor — NOT when moving between Primary/Backup.
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) commit(); }}
      style={{
        position: "absolute", top: "100%", left: 0, zIndex: 40, marginTop: 2,
        background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 6,
        padding: "8px 10px", boxShadow: "0 6px 18px rgba(0,0,0,0.18)", width: 200, textAlign: "left",
      }}
    >
      <label className="muted" style={{ display: "block", fontSize: 10 }}>Primary</label>
      <input
        autoFocus
        list="username-patterns"
        value={draft}
        disabled={saving}
        placeholder="{first}.{last}"
        style={{ width: "100%", padding: "2px 6px", boxSizing: "border-box" }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKey}
      />
      <label className="muted" style={{ display: "block", fontSize: 10, marginTop: 6 }}>Backup (if primary is taken)</label>
      <input
        list="username-patterns"
        value={draftBackup}
        disabled={saving}
        placeholder="{first}.{mi} (optional)"
        style={{ width: "100%", padding: "2px 6px", boxSizing: "border-box" }}
        onChange={(e) => setDraftBackup(e.target.value)}
        onKeyDown={onKey}
      />
      <div className="note" style={{ marginTop: 4 }}>
        John Jason Doe → {formatPreview(draft, domain)}
        {draftBackup.trim() && <><br />backup → {formatPreview(draftBackup, domain)}</>}
      </div>
    </div>
  );
}
