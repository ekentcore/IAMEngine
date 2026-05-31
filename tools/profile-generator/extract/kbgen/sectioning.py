"""Turn runbook HTML into normalised sections. Section headers are the reliable system
signal (per data/README); this module finds them and captures each section's body text."""
from __future__ import annotations

import re
from dataclasses import dataclass

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


@dataclass
class Section:
    raw_header: str
    header: str  # normalized
    level: int
    text: str


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
        sections.append(Section(raw, norm, int(h.name[1]), _body_text(h, header_ids)))
    return sections


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
