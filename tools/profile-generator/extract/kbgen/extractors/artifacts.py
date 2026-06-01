"""Typed-artifact extractors. Unlike the per-system signal extractors, these run on EVERY
section's HTML and surface non-step content an operator acts on: email templates (sent to a
client help desk), and — added in the attachment feature — linked spreadsheets. Register a
detector in ARTIFACT_DETECTORS; extract_artifacts() runs them all over a section.

Heuristic + reviewed: drafts are checked before promotion. The one known email template is
LogicSource's 'OneMarket Apps' section; the parser is built to that real structure."""
from __future__ import annotations

import re
from html import unescape

from bs4 import BeautifulSoup, Tag

_MAILTO = "mailto:"
_SYS_ID = re.compile(r"sys_id=([0-9a-f]{32})", re.I)
# a "Label:" line with an empty value — the fill-in fields of a template body
_FIELD = re.compile(r"^\s*([A-Za-z][\w /]*?):\s*$")
_SUBJECT = re.compile(r"^Subject:\s*(.+)$", re.I)  # matched per text node, not the flat blob
_CC_TAIL = re.compile(r"\bwith the case number.*$", re.I)
# addresses that are us, never a client help desk — treated as CC, not To
_OUR_DOMAINS = ("core.tech", "coretelligent.com")


def _addr(anchor: Tag) -> str:
    return unescape((anchor.get("href") or "")[len(_MAILTO):]).strip().lower()


def _nearest_block_text(anchor: Tag) -> str:
    """Text of the anchor's nearest li/p/div ancestor — used to tell a 'CC …' line from an
    'Email: …' line."""
    for a in anchor.parents:
        if isinstance(a, Tag) and a.name in ("li", "p", "div"):
            return unescape(a.get_text(" ", strip=True))
    return ""


def extract_email(html: str) -> dict | None:
    """Parse a section's HTML into an email artifact, or None if it isn't an email template.
    Shape: {type, to[], cc[], subject, body, fields[]}."""
    soup = BeautifulSoup(html or "", "lxml")
    text = unescape(soup.get_text(" ", strip=True))
    anchors = [a for a in soup.find_all("a") if (a.get("href") or "").startswith(_MAILTO)]
    # Subject lives in its own text node ("Subject: …"); the flat blob can't isolate it.
    subject = ""
    for s in soup.stripped_strings:
        m = _SUBJECT.match(unescape(s).strip())
        if m:
            subject = m.group(1).strip()
            break
    # An email template needs recipients and either a Subject: line or a body skeleton.
    if not anchors or not (subject or "email template" in text.lower()):
        return None

    to: list[str] = []
    cc: list[str] = []
    cc_names: list[str] = []
    for a in anchors:
        addr = _addr(a)
        if not addr:
            continue
        block = _nearest_block_text(a)
        is_cc = bool(re.search(r"\bcc\b", block, re.I)) or addr.endswith(_OUR_DOMAINS)
        bucket = cc if is_cc else to
        if addr not in bucket:
            bucket.append(addr)
        if is_cc:
            # pull named recipients out of the CC instruction ("CC Scotty Forrest and <addr> …")
            names = block
            for x in anchors:
                names = names.replace(_addr(x), "").replace(unescape(x.get_text(" ", strip=True)), "")
            names = _CC_TAIL.sub("", re.sub(r"^\s*cc\b", "", names, flags=re.I))
            for n in re.split(r"\band\b|,", names):
                n = n.strip("  ")
                if n and n not in cc_names:
                    cc_names.append(n)

    body = ""
    pre = soup.find("pre")
    if pre:
        body = unescape(pre.get_text())
    fields = [m.group(1).strip() for line in body.splitlines() if (m := _FIELD.match(line))]

    if not to and not cc:
        return None
    return {"type": "email", "to": to, "cc": cc_names + cc, "subject": subject, "body": body, "fields": fields}


def extract_attachments(html: str) -> list[dict]:
    """sys_attachment links (group-mapping spreadsheets, tear-off forms) the app can pull and
    parse later. Shape: {type, href, sysId, filename}. Skips empty-text anchors — those are
    embedded form images, not files an operator opens."""
    soup = BeautifulSoup(html or "", "lxml")
    out: list[dict] = []
    for a in soup.find_all("a"):
        href = unescape(a.get("href") or "")
        if "sys_attachment" not in href.lower():
            continue
        filename = a.get_text(" ", strip=True)
        if not filename:
            continue
        m = _SYS_ID.search(href)
        out.append({"type": "attachment", "href": href, "sysId": m.group(1) if m else None, "filename": filename})
    return out


# Detectors run over each section's HTML; each returns a list of artifact dicts. Add one here.
ARTIFACT_DETECTORS = [lambda h: ([extract_email(h)] if extract_email(h) else []), extract_attachments]


def extract_artifacts(html: str) -> list[dict]:
    """All typed artifacts found in a section's HTML, in detector order."""
    out: list[dict] = []
    for detect in ARTIFACT_DETECTORS:
        out.extend(detect(html))
    return out
