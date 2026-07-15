"use client";

// Point-and-click pickers backed by AD objects the agent discovered from the DC (client.adObjects).
// OuTreePicker renders discovered folders — OUs, containers (CN=Users, …) and the domain root — as a
// collapsible tree (DNs nest by their parent); clicking a node returns its full DN. The `ous` prop is
// the flat DN list; despite the historical name it now carries every folder kind. Groups use
// TagList's `options` dropdown (see condition-builder.tsx).
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { folderLabel, folderKind, buildTree } from "@/lib/clients/ad-folders";

// Icon per node kind so a container reads differently from an OU at a glance.
const KIND_ICON = { ou: "📁", container: "🗄", domain: "🌳" } as const;
const folderIcon = (dn: string) => KIND_ICON[folderKind(dn)];

const boxStyle: CSSProperties = { maxHeight: 280, overflowY: "auto", border: "1px solid #ddd", borderRadius: 4, padding: 4, background: "#fff", fontSize: 13 };
const rowStyle: CSSProperties = { display: "flex", gap: 4, alignItems: "center", padding: "2px 4px", borderRadius: 3, whiteSpace: "nowrap" };

export function OuTreePicker({ ous, onPick }: { ous: string[]; onPick: (dn: string) => void }) {
  const { children, roots } = useMemo(() => buildTree(ous), [ous]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const toggle = (dn: string) => setExpanded((s) => { const n = new Set(s); if (n.has(dn)) n.delete(dn); else n.add(dn); return n; });

  if (!ous.length) {
    return <p className="note">No folders discovered yet — use “⟳ Refresh AD objects from DC” above.</p>;
  }

  // Filtering shows flat full-DN matches (easier than expanding the tree to find one).
  if (filter.trim()) {
    const matches = ous.filter((dn) => dn.toLowerCase().includes(filter.toLowerCase())).slice(0, 60);
    return (
      <div>
        <input className="inline" placeholder="filter folders…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: "100%", marginBottom: 4 }} autoFocus />
        <div style={boxStyle}>
          {matches.length === 0 ? <div className="note" style={{ padding: 6 }}>no match</div>
            : matches.map((dn) => (
              <div key={dn} style={{ ...rowStyle, cursor: "pointer" }} onMouseDown={(e) => { e.preventDefault(); onPick(dn); }} title={dn}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#eef")} onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                <code style={{ fontSize: 11 }}>{dn}</code>
              </div>
            ))}
        </div>
      </div>
    );
  }

  const renderNode = (dn: string, depth: number): JSX.Element => {
    const kids = children.get(dn) ?? [];
    const isOpen = expanded.has(dn);
    return (
      <div key={dn}>
        <div style={{ ...rowStyle, paddingLeft: 6 + depth * 14 }}>
          {kids.length > 0
            ? <span onMouseDown={(e) => { e.preventDefault(); toggle(dn); }} style={{ cursor: "pointer", width: 12, display: "inline-block", color: "#888" }}>{isOpen ? "▾" : "▸"}</span>
            : <span style={{ width: 12, display: "inline-block" }} />}
          <span onMouseDown={(e) => { e.preventDefault(); onPick(dn); }} style={{ cursor: "pointer" }} title={dn}
            onMouseEnter={(e) => (e.currentTarget.style.color = "#1565c0")} onMouseLeave={(e) => (e.currentTarget.style.color = "")}>
            {folderIcon(dn)} {folderLabel(dn)}
          </span>
        </div>
        {isOpen && kids.map((k) => renderNode(k, depth + 1))}
      </div>
    );
  };

  return (
    <div>
      <input className="inline" placeholder="filter folders…" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ width: "100%", marginBottom: 4 }} />
      <div style={boxStyle}>{roots.map((r) => renderNode(r, 0))}</div>
    </div>
  );
}
