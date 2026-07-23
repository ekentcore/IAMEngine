"use client";

// Generic v3 data table: the "advanced table" chrome shared by the v3 list pages that don't already
// ship their own rich table (Cases keeps CasesTable). Column-header sorting, a debounce-free text
// filter over the searchable columns, a live "showing N of M" count, sticky header, and a mobile
// card fallback — all driven by a small column spec so a page just describes its columns and rows.
import { useMemo, useState, type ReactNode } from "react";

export type Column<T> = {
  key: string;
  header: ReactNode;
  // Cell renderer. Defaults to String(row[key]) when omitted.
  render?: (row: T) => ReactNode;
  // Value used for sorting + text search. Return a string or number. Defaults to String(row[key]).
  sortValue?: (row: T) => string | number;
  sortable?: boolean; // default true
  searchable?: boolean; // included in the text filter's haystack — default true
  align?: "left" | "right" | "center";
  numeric?: boolean; // right-align + numeric sort styling
  width?: number | string;
};

type Props<T> = {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  // Optional row link/href — makes the whole row (and the mobile card) navigate.
  href?: (row: T) => string;
  searchPlaceholder?: string;
  initialSortKey?: string;
  initialSortDir?: "asc" | "desc";
  emptyMessage?: ReactNode;
  // Column key to use as the mobile card's title (defaults to the first column).
  mobileTitleKey?: string;
};

function raw<T>(col: Column<T>, row: T): string | number {
  if (col.sortValue) return col.sortValue(row);
  const v = (row as Record<string, unknown>)[col.key];
  if (typeof v === "number") return v;
  return v == null ? "" : String(v);
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  href,
  searchPlaceholder = "Search…",
  initialSortKey,
  initialSortDir = "asc",
  emptyMessage = "Nothing to show.",
  mobileTitleKey,
}: Props<T>) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<string | null>(initialSortKey ?? null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">(initialSortDir);

  const terms = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const searchCols = useMemo(() => columns.filter((c) => c.searchable !== false), [columns]);

  const visible = useMemo(() => {
    const filtered = rows.filter((r) => {
      if (terms.length === 0) return true;
      const hay = searchCols.map((c) => String(raw(c, r)).toLowerCase()).join(" ");
      return terms.every((t) => hay.includes(t));
    });
    if (!sortKey) return filtered;
    const col = columns.find((c) => c.key === sortKey);
    if (!col) return filtered;
    const sorted = [...filtered].sort((a, b) => {
      const av = raw(col, a);
      const bv = raw(col, b);
      if (typeof av === "number" && typeof bv === "number") return av - bv;
      const as = String(av);
      const bs = String(bv);
      if (!as && bs) return 1; // empties last
      if (as && !bs) return -1;
      return as.localeCompare(bs);
    });
    if (sortDir === "desc") sorted.reverse();
    return sorted;
  }, [rows, terms, searchCols, sortKey, sortDir, columns]);

  function toggleSort(col: Column<T>) {
    if (col.sortable === false) return;
    if (col.key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(col.key);
      setSortDir(col.numeric ? "desc" : "asc");
    }
  }

  const titleKey = mobileTitleKey ?? columns[0]?.key;

  function cell(col: Column<T>, row: T): ReactNode {
    if (col.render) return col.render(row);
    const v = (row as Record<string, unknown>)[col.key];
    return v == null || v === "" ? <span className="muted">—</span> : String(v);
  }

  return (
    <>
      <div className="filters" style={{ marginTop: "1rem" }}>
        <div className="search-field">
          <span className="search-icon" aria-hidden>⌕</span>
          <input
            className="search"
            placeholder={searchPlaceholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
          {query && <button type="button" className="search-clear" aria-label="Clear search" onClick={() => setQuery("")}>×</button>}
        </div>
        <span className="note" style={{ marginLeft: "auto" }}>{visible.length} of {rows.length}</span>
      </div>

      <table className="desk-only data-table">
        <thead>
          <tr>
            {columns.map((col) => {
              const isSorted = sortKey === col.key;
              const sortable = col.sortable !== false;
              return (
                <th
                  key={col.key}
                  className={`${sortable ? "sortable" : ""}${col.numeric ? " num" : ""}${isSorted ? " sorted" : ""}`}
                  style={{ width: col.width, textAlign: col.align ?? (col.numeric ? "right" : "left") }}
                  onClick={sortable ? () => toggleSort(col) : undefined}
                >
                  {col.header}
                  {sortable && <span className="arrow">{isSorted ? (sortDir === "asc" ? "▲" : "▼") : ""}</span>}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {visible.map((row) => (
            <tr key={rowKey(row)} className={href ? "data-row-link" : undefined}>
              {columns.map((col, i) => (
                <td key={col.key} style={{ textAlign: col.align ?? (col.numeric ? "right" : "left") }}>
                  {href && i === 0 ? <a href={href(row)}>{cell(col, row)}</a> : cell(col, row)}
                </td>
              ))}
            </tr>
          ))}
          {visible.length === 0 && (
            <tr>
              <td colSpan={columns.length} className="muted" style={{ textAlign: "center", padding: "2rem" }}>
                {terms.length ? "Nothing matches your search." : emptyMessage}
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {/* Mobile: one tappable card per row. */}
      <div className="mob-only m-list">
        {visible.map((row) => {
          const title = titleKey ? cell(columns.find((c) => c.key === titleKey)!, row) : null;
          const body = (
            <>
              <div className="m-card-top"><span className="m-card-title">{title}</span></div>
              <div className="m-card-meta">
                {columns.filter((c) => c.key !== titleKey).map((c) => (
                  <span key={c.key}><span className="k">{typeof c.header === "string" ? c.header : c.key}</span> {cell(c, row)}</span>
                ))}
              </div>
            </>
          );
          return href
            ? <a key={rowKey(row)} href={href(row)} className="m-card">{body}</a>
            : <div key={rowKey(row)} className="m-card">{body}</div>;
        })}
        {visible.length === 0 && <div className="note" style={{ padding: "1rem 0" }}>{terms.length ? "Nothing matches." : emptyMessage}</div>}
      </div>
    </>
  );
}
