"""The system catalog + section->system mapping table.

This is the data-driven core of extraction. To teach the generator a new system:
  1. add its key to CATALOG (mirrors docs/modules/_INDEX.md) with a default mode, and
  2. add one or more header aliases to SECTION_ALIASES.
Optionally register a rich extractor in extractors/ for structured signals (licenses,
groups, OU, ...). Everything else falls through to a presence signal or the unmodeled
report. Order in SECTION_ALIASES matters: most specific patterns first.
"""
from __future__ import annotations

import re

# system key -> default execution mode. Keys mirror docs/modules/_INDEX.md and the
# profile schema's known-keys list.
CATALOG: dict[str, str] = {
    "servicenow": "api",
    "m365": "api",
    "entra": "api",
    "exchange": "api",
    "active-directory": "api",
    "directory-sync": "api",
    "mimecast": "api",
    "proofpoint": "api",
    "adobe": "api",
    "google-workspace": "api",
    "knowbe4": "api",
    "spanning": "api",
    "sharepoint": "api",
    "zoom": "api",
    "slack": "api",
    "egnyte": "api",
    "egnyte-sync-server": "browser",
    "mdm": "api",
    "dropbox": "api",
    "perimeter81": "api",
    "teams": "api",
    "avd": "api",
    "1password": "api",
    "notion": "api",
    "tableau": "manual",
    "printix": "api",
    "address-book": "browser",
    "hardware": "manual",
    "workstation": "manual",
    "welcome-letter": "manual",
    "first-day-call": "manual",
    "archive": "api",
    "data-transfer": "api",
    "equipment-return": "manual",
    "case-resolution": "api",
}

# (regex pattern matched against the NORMALISED header, system key). First match wins,
# so order specific -> general. Normalisation (sectioning.normalize_header) lowercases,
# drops parentheticals/step-prefixes, and keeps the segment after an em/en dash.
SECTION_ALIASES: list[tuple[str, str]] = [
    # --- email security (specific before generic 'email') ---
    (r"\bmimecast\b", "mimecast"),
    (r"\bproofpoint\b", "proofpoint"),
    # --- Microsoft stack: order matters, exchange/entra before generic 365 ---
    (r"exchange( admin)?( center)?", "exchange"),
    (r"mailbox audit", "exchange"),
    (r"(microsoft |azure )?entra( id)?( admin)?", "entra"),
    (r"azure (active directory|ad|admin)", "entra"),
    # require a qualifier so a bare '365' (e.g. 'after 365 days') is NOT matched as m365.
    (r"(?:microsoft|ms|office) 365|365 admin(?: center)?|\bm365\b", "m365"),
    (r"\bo365\b", "m365"),
    (r"^admin center$", "m365"),
    (r"email account", "m365"),
    # --- on-prem identity ---
    (r"\bad sync\b", "directory-sync"),
    (r"directory sync", "directory-sync"),
    (r"active directory", "active-directory"),
    (r"domain( setup| part \d+)?$", "active-directory"),
    # --- core service desk ---
    (r"service ?now", "servicenow"),
    (r"^snow$", "servicenow"),
    (r"^sn$", "servicenow"),
    (r"case resolution|resolving (the )?case", "case-resolution"),
    # --- backup / storage ---
    (r"\bspanning\b", "spanning"),
    (r"\begnyte sync server\b", "egnyte-sync-server"),
    (r"\begnyte\b", "egnyte"),
    (r"\bdropbox\b", "dropbox"),
    (r"\bsharepoint\b", "sharepoint"),
    # --- identity-adjacent SaaS ---
    (r"g[\s-]?suite", "google-workspace"),
    (r"google( workspace)?", "google-workspace"),
    (r"knowbe4", "knowbe4"),
    (r"\bzoom\b", "zoom"),
    (r"\bslack\b", "slack"),
    (r"\bteams\b", "teams"),
    (r"adobe( acrobat)?( pro)?( ?/ ?creative cloud)?", "adobe"),
    (r"creative cloud", "adobe"),
    (r"\bnotion\b", "notion"),
    (r"\btableau\b", "tableau"),
    (r"1 ?password", "1password"),
    # --- network / endpoint ---
    (r"perimeter ?81", "perimeter81"),
    (r"vpn(/rds| setup)?", "perimeter81"),
    (r"\bavd\b|azure virtual desktop", "avd"),
    (r"\bjamf\b|\bintune\b|\baddigy\b|\bmdm\b", "mdm"),
    (r"\bprintix\b", "printix"),
    (r"printer address book|address book", "address-book"),
    # --- lifecycle / manual ---
    (r"welcome letter|info email", "welcome-letter"),
    (r"first[\s-]?day", "first-day-call"),
    (r"\bworkstation\b", "workstation"),
    (r"hardware(/data)?", "hardware"),
    (r"after \d+ days|^archive$", "archive"),
    (r"equipment return", "equipment-return"),
]

# Headers that are recognisably a system/vendor we do NOT model yet. Maps a pattern to a
# friendly guess label for the "systems detected but not yet modeled" report.
UNMODELED_GUESSES: list[tuple[str, str]] = [
    (r"\bduo\b", "Duo (MFA)"),
    (r"\bbox\b", "Box (storage)"),
    (r"salesforce", "Salesforce"),
    (r"idaptive", "Idaptive (CyberArk SSO)"),
    (r"lastpass", "LastPass"),
    (r"smartsheet", "Smartsheet"),
    (r"global relay", "Global Relay (archiving)"),
    (r"sso application", "SSO application (generic)"),
    (r"lob( applications| account removal)?", "LOB / line-of-business apps"),
]

# Procedural / structural headers that are NOT systems — ignored entirely (not reported
# as unmodeled, to keep that report signal-rich).
NOISE_HEADERS: set[str] = {
    "table of contents", "overview", "introduction", "summary", "notes",
    "final steps", "first steps", "prerequisites", "general", "background",
    "references", "user profile",
}


def classify_header(header: str) -> tuple[str, str | None]:
    """Classify a normalised header. Returns one of:
      ("system", <catalog key>)   — maps to a modelled system
      ("unmodeled", <guess|None>) — a system/vendor we don't model yet
      ("noise", None)             — procedural/structural, ignore
    """
    if header in NOISE_HEADERS:
        return ("noise", None)
    for pattern, key in SECTION_ALIASES:
        if re.search(pattern, header):
            return ("system", key)
    for pattern, guess in UNMODELED_GUESSES:
        if re.search(pattern, header):
            return ("unmodeled", guess)
    return ("unmodeled", None)
