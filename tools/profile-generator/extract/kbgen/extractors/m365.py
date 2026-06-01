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


# "Username: FirstInitialLastName@domain" — capture the descriptive local part.
_USERNAME = re.compile(r"user\s?name\s*[:\-]?\s*([A-Za-z.]+)\s*@", re.I)
_WORD_NUM = {"eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "fourteen": 14, "sixteen": 16}


def _username_pattern(text: str) -> str | None:
    m = _USERNAME.search(text)
    if not m:
        return None
    raw = m.group(1)
    core = raw.lower().replace(".", "")
    dotted = "." in raw
    if "firstinitial" in core and "last" in core:
        local = "{firstInitial}{last}"
    elif "first" in core and "lastinitial" in core:
        local = "{first}{lastInitial}"
    elif core in ("flast", "flastname"):
        local = "{firstInitial}{last}"
    elif "first" in core and "last" in core:
        local = "{first}.{last}" if dotted else "{first}{last}"
    else:
        return None
    return f"{local}@{{domain}}"


def _password_rules(text: str) -> dict:
    low = text.lower()
    pw: dict = {}
    m = re.search(r"(?:minimum|at least)\s+(\w+)\s+character", low)
    if m:
        tok = m.group(1)
        n = int(tok) if tok.isdigit() else _WORD_NUM.get(tok)
        if n:
            pw["minLength"] = n
    if "special character" in low:
        pw["requireSpecial"] = True
    if re.search(r"\bnumber\b|\bdigit\b", low):
        pw["requireNumber"] = True
    if "uppercase" in low:
        pw["requireUpper"] = True
    if "lowercase" in low:
        pw["requireLower"] = True
    return pw


@register("m365")
def extract(section: Section) -> dict:
    sig: dict = {}
    seen: list[str] = []
    for m in LICENSE_RE.finditer(section.text):
        lic = m.group(0)
        if lic not in seen:
            seen.append(lic)
    if seen:
        sig["licenses"] = seen
    up = _username_pattern(section.text)
    if up:
        sig["usernamePattern"] = up
    pw = _password_rules(section.text)
    if pw:
        sig["password"] = pw
    return sig
