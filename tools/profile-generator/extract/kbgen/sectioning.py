"""Turn runbook HTML into normalised sections. Section headers are the reliable system
signal (per data/README); this module finds them and captures each section's body text."""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from bs4 import BeautifulSoup, NavigableString, Tag

from .catalog import NOISE_HEADERS

HEADER_TAGS = ("h1", "h2", "h3", "h4")
# headers longer than this are almost always embedded prose / signatures, not a system.
MAX_HEADER_WORDS = 6

_STEP_PREFIX = re.compile(r"^(?:step\s+\d+\s*[:.)\-]?\s*|\d+\s*[.):\-]\s*)", re.I)
_PARENS = re.compile(r"\(.*?\)")
_SPACED_DASH = re.compile(r"\s+[—–-]\s+")
_WS = re.compile(r"\s+")


def normalize_header(raw: str) -> str:
    """Lowercase; drop parentheticals and 'Step N:' / 'N.' prefixes; normalise any spaced
    em/en dash to ' - ' but keep BOTH sides, so the classifier can substring-match either
    ('Microsoft 365 — Entra Admin' -> 'microsoft 365 - entra admin' matches entra;
    'Active Directory - Yee' -> 'active directory - yee' matches active-directory)."""
    s = _WS.sub(" ", raw or "").strip().lower()
    s = _PARENS.sub("", s)
    s = _STEP_PREFIX.sub("", s)
    s = _SPACED_DASH.sub(" - ", s)
    s = s.rstrip(":").strip(" -").strip()
    return _WS.sub(" ", s)


LIST_TAGS = ("ul", "ol")
STEP_TAGS = ("li", "p")
# KB "step-section" blocks wrap an instruction (a leading <span>/text) plus a nested
# "step" div holding the list. We capture the instruction and exclude the nested step div
# from a parent's own text so the instruction and its list items don't double up.
STEP_DIV_CLASSES = ("step", "step-section")


def _is_step_div(el: Tag) -> bool:
    return el.name == "div" and any(c in STEP_DIV_CLASSES for c in (el.get("class") or []))


@dataclass
class Section:
    raw_header: str
    header: str  # normalized
    level: int
    text: str
    # ordered runbook steps (list items + paragraphs), nested = indented
    steps: list[str] = field(default_factory=list)
    # the section's inner HTML — kept so artifact extractors can read anchors/structure
    html: str = ""


def split_sections(html: str) -> list[Section]:
    """Sections in document order, excluding noise headers (table of contents, etc.)."""
    soup = BeautifulSoup(html or "", "lxml")
    header_tags = soup.find_all(HEADER_TAGS)
    header_ids = {id(h) for h in header_tags}
    sections: list[Section] = []
    for h in header_tags:
        raw = h.get_text(" ", strip=True)
        norm = normalize_header(raw)
        if not norm or norm in NOISE_HEADERS or len(norm.split()) > MAX_HEADER_WORDS:
            continue
        sections.append(Section(raw, norm, int(h.name[1]), _body_text(h, header_ids),
                                _section_steps(h, header_ids), _section_html(h, header_ids)))
    return sections


def _section_html(header: Tag, header_ids: set[int]) -> str:
    """Inner HTML of the section: each maximal block after the header up to the next header.
    A block that itself contains a later header is descended into (so the next section's
    header div isn't swallowed); descendants of an already-captured block are skipped."""
    captured: set[int] = set()
    parts: list[str] = []
    for el in header.next_elements:
        if not isinstance(el, Tag):
            continue
        if el.name in HEADER_TAGS and id(el) in header_ids:
            break
        parents = {id(a) for a in el.parents}
        if id(header) in parents:
            continue  # the header's own descendants (e.g. its <span>)
        if captured & parents:
            continue  # inside a block we already captured
        if any(isinstance(d, Tag) and d.name in HEADER_TAGS and id(d) in header_ids for d in el.descendants):
            continue  # wrapper of a later header — descend into it instead of capturing whole
        parts.append(str(el))
        captured.add(id(el))
    return "".join(parts)


def _own_text(el: Tag) -> str:
    """An element's own text, excluding any nested list and nested step div (their items
    become their own steps)."""
    parts: list[str] = []
    for c in el.children:
        if isinstance(c, NavigableString):
            parts.append(str(c))
        elif isinstance(c, Tag) and c.name not in LIST_TAGS and not _is_step_div(c):
            parts.append(c.get_text(" "))
    return _WS.sub(" ", " ".join(parts)).strip()


def _step_depth(el: Tag) -> int:
    """Nesting depth used for indentation: list ancestors plus step-section ancestors, so a
    list inside a step-section indents one level under its instruction line."""
    return sum(
        1
        for a in el.parents
        if isinstance(a, Tag)
        and (a.name in LIST_TAGS or (a.name == "div" and "step-section" in (a.get("class") or [])))
    )


def _section_steps(header: Tag, header_ids: set[int]) -> list[str]:
    """Discrete steps from the section body, in document order: the instruction text of each
    step-section, each <li> (own text), and each top-level <p>; nested items are indented."""
    steps: list[str] = []
    for el in header.next_elements:
        if isinstance(el, Tag) and el.name in HEADER_TAGS and id(el) in header_ids:
            break
        if not isinstance(el, Tag):
            continue
        # The leading instruction of a step-section (e.g. "Verify the user was added to …"),
        # which lives outside any <li>/<p>; its nested list items follow as sub-steps.
        if el.name == "div" and "step-section" in (el.get("class") or []):
            txt = _own_text(el)
            if txt:
                steps.append("  " * max(0, _step_depth(el) - 1) + txt)
            continue
        if el.name not in STEP_TAGS:
            continue
        if el.name == "p" and any(isinstance(a, Tag) and a.name == "li" for a in el.parents):
            continue  # a <p> inside an <li> is already folded into that li's own text
        txt = _own_text(el)
        if not txt:
            continue
        if el.name == "li":
            steps.append("  " * max(0, _step_depth(el) - 1) + txt)
        else:
            steps.append(txt)
    return steps


def _body_text(header: Tag, header_ids: set[int]) -> str:
    parts: list[str] = []
    for el in header.next_elements:
        if isinstance(el, Tag) and el.name in HEADER_TAGS and id(el) in header_ids:
            break
        if isinstance(el, NavigableString):
            if header in el.parents:  # the header's own text — skip
                continue
            s = el.strip()
            if s:
                parts.append(s)
    return _WS.sub(" ", " ".join(parts)).strip()
