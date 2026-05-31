"""M365 rich extractor: pull license SKUs out of the section body. Best-effort — drafts
are reviewed. Extend LICENSE_RE with new SKUs as they appear in the unmodeled report."""
from __future__ import annotations

import re

from ..registry import register
from ..sectioning import Section

LICENSE_RE = re.compile(
    r"""
      Microsoft\ 365\ (?:E[35]|F[13]|Business\ (?:Premium|Standard|Basic))
    | Office\ 365\ (?:E[135]|F3)
    | Microsoft\ Entra\ ID\ P[12]
    | (?:Microsoft\ )?Exchange\ Online\ \(Plan\ [12]\)
    | Microsoft\ Defender\ for\ Office\ 365\ \(Plan\ [12]\)
    | Microsoft\ Teams\ (?:Phone\ Standard|Domestic\ Calling\ Plan|Enterprise)
    | Microsoft\ Teams\ Audio\ Conferencing
    | Microsoft\ Intune\ Plan\ [12]
    | Power\ BI\ Pro
    | Visio\ Plan\ [12]
    | Project\ Plan\ [135]
    """,
    re.X,
)


@register("m365")
def extract(section: Section) -> dict:
    seen: list[str] = []
    for m in LICENSE_RE.finditer(section.text):
        lic = m.group(0)
        if lic not in seen:
            seen.append(lic)
    return {"licenses": seen} if seen else {}
