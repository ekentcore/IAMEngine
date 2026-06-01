#!/usr/bin/env python3
"""Extract KB article numbers + section order from the raw ServiceNow KB exports
and write a `kb` block into each client profile.

This is the INTERIM source. The raw exports live in the gitignored `data/`
directory (sensitive: the article bodies are client runbooks). Only the KB
*number* and the generic `<h2>` section headings are lifted into the committed
profiles. When a direct ServiceNow pull lands, it replaces this script behind
the same contract: "write a `kb` block into each profile".

Usage (from repo root):  python3 tools/kb/extract_kb.py
Inputs:   data/kb_onboarding_raw.xlsx, data/kb_offboarding_raw.xlsx
Outputs:  profiles/*.json gain  "kb": { "onboard": {number, sections}, "offboard": {...} }

No third-party dependencies: an .xlsx is a zip of XML, and these exports use
inline strings (empty sharedStrings), so stdlib zipfile + regex is enough.
"""
from __future__ import annotations

import json
import re
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data"
PROFILES = ROOT / "profiles"

ONBOARD_XLSX = DATA / "kb_onboarding_raw.xlsx"
OFFBOARD_XLSX = DATA / "kb_offboarding_raw.xlsx"

# Columns in the export (see header row); letters are the spreadsheet columns.
COL_NUMBER = "A"          # e.g. KB0037439
COL_SHORT_DESC = "C"      # "New User Onboarding Guide - <Client>"
COL_DOMAIN_REF = "AC"     # clean client name — the match key
COL_ARTICLE_BODY = "L"    # HTML; <h2> headings give the section order

# Legal suffixes / filler dropped before token matching a profile to an article.
_STOPWORDS = {"llc", "inc", "lp", "ltd", "co", "corp", "the", "and"}


def _unescape(s: str) -> str:
    return (
        s.replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
        .replace("&#xa;", "\n")
        .replace("&#10;", "\n")
        .replace("&apos;", "'")
        .replace("&#xa0;", " ")
        .replace("&#160;", " ")
        .replace("&nbsp;", " ")
    )


def _read_rows(xlsx: Path) -> list[dict[str, str]]:
    """Return each data row as {column_letter: text}. First row is the header."""
    with zipfile.ZipFile(xlsx) as z:
        sheet = z.read("xl/worksheets/sheet1.xml").decode("utf-8")
    rows: list[dict[str, str]] = []
    for _, body in re.findall(r'<row[^>]*r="(\d+)"[^>]*>(.*?)</row>', sheet, re.S):
        cells: dict[str, str] = {}
        for cell in re.finditer(r'<c r="([A-Z]+)\d+"[^>]*>(.*?)</c>', body, re.S):
            col = re.match(r"[A-Z]+", cell.group(1)).group()
            t = re.search(r"<t[^>]*>(.*?)</t>", cell.group(2), re.S)
            cells[col] = _unescape(t.group(1)) if t else ""
        if cells:
            rows.append(cells)
    return rows[1:] if rows else []  # drop header


def _sections(article_body: str) -> list[str]:
    """Ordered <h2> section headings, excluding the table of contents."""
    out: list[str] = []
    for m in re.finditer(r"<h2[^>]*>(.*?)</h2>", article_body, re.S):
        text = re.sub(r"<[^>]+>", "", m.group(1))
        text = re.sub(r"\s+", " ", _unescape(text)).strip()
        if text and text.lower() != "table of contents":
            out.append(text)
    return out


def _tokens(name: str) -> list[str]:
    return [t for t in re.sub(r"[^a-z0-9]+", " ", name.lower()).split() if t and t not in _STOPWORDS]


def _index(xlsx: Path) -> list[tuple[list[str], dict]]:
    """[(tokens, {number, sections, name}), ...] for every article in the export."""
    index: list[tuple[list[str], dict]] = []
    for row in _read_rows(xlsx):
        name = row.get(COL_DOMAIN_REF, "").strip() or row.get(COL_SHORT_DESC, "").strip()
        number = row.get(COL_NUMBER, "").strip()
        if not name or not number:
            continue
        index.append((_tokens(name), {
            "number": number,
            "sections": _sections(row.get(COL_ARTICLE_BODY, "")),
            "name": name,
        }))
    return index


def _best_match(profile_name: str, index: list[tuple[list[str], dict]]) -> dict | None:
    """First-token + highest-overlap match. Requires the article to share the
    profile's leading token, so distinctive names ('regal', 'raith') resolve even
    when the rest differs ('Regal Healthcare CM' vs '... Capital Management')."""
    p = _tokens(profile_name)
    if not p:
        return None
    lead = p[0]
    best, best_score = None, 0
    for tokens, article in index:
        if lead not in tokens:
            continue
        score = len(set(p) & set(tokens))
        if score > best_score:
            best, best_score = article, score
    return best


def _format_kb_block(kb: dict) -> str:
    """Render the kb block as JSON text matching the profiles' hand-formatting
    (2-space indent, one line per lane)."""
    def lane(d: dict) -> str:
        secs = ", ".join(json.dumps(s) for s in d["sections"])
        return f'{{ "number": {json.dumps(d["number"])}, "sections": [{secs}] }}'
    return (
        '  "kb": {\n'
        f'    "onboard":  {lane(kb["onboard"])},\n'
        f'    "offboard": {lane(kb["offboard"])}\n'
        "  },\n"
    )


# Existing kb block: from `  "kb": {` to its closing `  },` (2-space indent).
_KB_BLOCK_RE = re.compile(r'(?ms)^  "kb": \{.*?^  \},\n')


def _write_kb(profile_path: Path, kb: dict) -> bool:
    text = profile_path.read_text(encoding="utf-8")
    block = _format_kb_block(kb)
    if _KB_BLOCK_RE.search(text):
        new = _KB_BLOCK_RE.sub(block, text, count=1)
    else:
        # Insert before the "identity" top-level key (kb belongs with client metadata).
        m = re.search(r'(?m)^  "identity": \{', text)
        if not m:
            raise SystemExit(f"{profile_path.name}: cannot find insertion point (\"identity\")")
        new = text[: m.start()] + block + "\n" + text[m.start():]
    if new == text:
        return False
    profile_path.write_text(new, encoding="utf-8")
    return True


def main() -> int:
    for xlsx in (ONBOARD_XLSX, OFFBOARD_XLSX):
        if not xlsx.exists():
            print(f"missing input: {xlsx.relative_to(ROOT)} (place the raw export in data/)", file=sys.stderr)
            return 1

    onboard = _index(ONBOARD_XLSX)
    offboard = _index(OFFBOARD_XLSX)
    print(f"indexed {len(onboard)} onboarding + {len(offboard)} offboarding articles")

    changed = matched = 0
    for profile_path in sorted(PROFILES.glob("*.json")):
        if profile_path.name.startswith("_"):
            continue
        profile = json.loads(profile_path.read_text(encoding="utf-8"))
        name = profile.get("client", {}).get("name", "")
        on = _best_match(name, onboard)
        off = _best_match(name, offboard)
        if not on or not off:
            print(f"  ! {profile_path.name}: no KB match for {name!r} "
                  f"(onboard={'ok' if on else 'MISS'}, offboard={'ok' if off else 'MISS'})")
            continue
        matched += 1
        kb = {
            "onboard": {"number": on["number"], "sections": on["sections"]},
            "offboard": {"number": off["number"], "sections": off["sections"]},
        }
        if _write_kb(profile_path, kb):
            changed += 1
            print(f"  + {profile_path.name}: onboard {on['number']}, offboard {off['number']} "
                  f"(matched {on['name']!r})")
        else:
            print(f"  = {profile_path.name}: unchanged ({on['number']}/{off['number']})")

    print(f"matched {matched} profiles, updated {changed}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
