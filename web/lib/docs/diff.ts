// A minimal line-level diff for the draft-review screen: given the current published Markdown and a
// proposed draft, show what the AI changed. LCS-based (classic), which is ample for documents of a
// few hundred lines. Pure — unit-tested directly.
export type DiffLine = { type: "same" | "add" | "del"; text: string };

export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = (oldText ?? "").split("\n");
  const b = (newText ?? "").split("\n");
  const n = a.length;
  const m = b.length;

  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: "same", text: a[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ type: "del", text: a[i] });
      i++;
    } else {
      out.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) out.push({ type: "del", text: a[i++] });
  while (j < m) out.push({ type: "add", text: b[j++] });
  return out;
}

export type DiffStats = { added: number; removed: number };

export function diffStats(lines: DiffLine[]): DiffStats {
  return lines.reduce<DiffStats>((s, l) => ({ added: s.added + (l.type === "add" ? 1 : 0), removed: s.removed + (l.type === "del" ? 1 : 0) }), { added: 0, removed: 0 });
}

// Collapse long runs of unchanged lines to keep the review readable — keep `context` lines of
// context around each change, replace the rest of a run with a single marker line (type "same",
// text ""), which the UI renders as an ellipsis.
export function collapseUnchanged(lines: DiffLine[], context = 3): DiffLine[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type !== "same") {
      for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
    }
  }
  const out: DiffLine[] = [];
  let gap = false;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      out.push(lines[i]);
      gap = false;
    } else if (!gap) {
      out.push({ type: "same", text: "" }); // ellipsis marker
      gap = true;
    }
  }
  return out;
}
