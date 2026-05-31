"""Active Directory rich extractor: OU placement + the catastrophic-to-miss guardrails
(do-not-move-ou / do-not-delete / no-device-wipe-without-approval)."""
from __future__ import annotations

import re

from ..registry import register
from ..sectioning import Section

_OU_QUOTED = re.compile(r"['\"]([^'\"]+?)['\"]\s+OU\b")
# the run of Capitalised tokens immediately before 'OU' (e.g. '...the Six One Users OU'
# -> 'Six One Users'); lowercase words like 'their'/'the' break the run, so prose is not
# captured.
_OU_PLAIN = re.compile(r"\b([A-Z][\w&-]*(?:\s+[A-Z][\w&-]*){0,4})\s+OU\b")


@register("active-directory")
def extract(section: Section) -> dict:
    sig: dict = {}
    text = section.text
    m = _OU_QUOTED.search(text) or _OU_PLAIN.search(text)
    if m:
        sig["ou"] = m.group(1).strip()

    low = text.lower()
    guardrails: list[str] = []
    if "do not move" in low or "don't move" in low:
        guardrails.append("do-not-move-ou")
    if "do not delete" in low or "don't delete" in low:
        guardrails.append("do-not-delete")
    if "wipe" in low and "approval" in low:
        guardrails.append("no-device-wipe-without-approval")
    if guardrails:
        sig["guardrails"] = guardrails
    return sig
