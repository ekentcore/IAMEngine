"""Franchise-family detection + id suggestion.

CVP (Community Veterinary Partners) and Olympus are franchise families: many practices
share one runbook template. The family is detected from the client path; the assembler
overlays assemble/templates/<family>.json over the per-practice extraction.
"""
from __future__ import annotations

import re

# path prefix (lowercased substring) -> family key. Add a family by adding a line here
# and dropping a template in assemble/templates/<family>.json.
FAMILY_PREFIXES: list[tuple[str, str]] = [
    ("community veterinary partners", "cvp"),
    ("olympus", "olympus"),
]


def detect_family(path: str) -> str | None:
    # families are path PREFIXES (the franchise is the first segment), not substrings, so
    # an unrelated client merely containing 'olympus' is not mis-tagged.
    p = (path or "").lower()
    for needle, family in FAMILY_PREFIXES:
        if p.startswith(needle):
            return family
    return None


def suggest_id(leaf: str) -> str:
    """kebab-case slug matching the profile schema's client.id pattern ^[a-z0-9-]+$ AND the
    roster slug in web/lib/clients/sync-service.ts (deriveSlug), incl. its 40-char cap, so
    generated ids line up with ServiceNow roster slugs."""
    s = (leaf or "").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")[:40]
