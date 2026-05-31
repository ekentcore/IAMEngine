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
    p = (path or "").lower()
    for needle, family in FAMILY_PREFIXES:
        if needle in p:
            return family
    return None


def suggest_id(leaf: str) -> str:
    """kebab-case slug matching the profile schema's client.id pattern ^[a-z0-9-]+$."""
    s = (leaf or "").lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")
