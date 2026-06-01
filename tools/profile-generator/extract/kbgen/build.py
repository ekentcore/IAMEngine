"""Assemble a single client's KB records into the profile-generator IR."""
from __future__ import annotations

import re
from collections import Counter
from html import unescape

from .backbone import infer_backbone
from .catalog import CATALOG, classify_header
from .extractors.artifacts import extract_artifacts
from .families import detect_family, suggest_id
from .registry import extract_signals
from .sectioning import split_sections

_EMAIL = re.compile(r"@([a-z0-9][a-z0-9.-]*\.[a-z]{2,})", re.I)
_PLACEHOLDER = re.compile(r"\[replace|replace with|<client>", re.I)
# domains that are us / vendors, never the client's primary domain
_IGNORE_DOMAINS = {
    "coretelligent.com", "core.tech", "microsoft.com", "office.com", "gmail.com",
    "outlook.com", "example.com", "mimecast.com",
}


def _section_confidence(section, text: str) -> float:
    conf = 0.9
    if _PLACEHOLDER.search(text):
        conf -= 0.3
    if len(text) < 30:
        conf -= 0.2
    return max(0.3, min(0.95, round(conf, 2)))


def _infer_primary_domain(html_blobs: list[str]) -> str | None:
    counts: Counter[str] = Counter()
    for blob in html_blobs:
        for d in _EMAIL.findall(unescape(blob or "")):  # mailto: links encode '@' as &#64;
            d = d.lower()
            if d not in _IGNORE_DOMAINS:
                counts[d] += 1
    return counts.most_common(1)[0][0] if counts else None


def build_client_ir(records: list[dict]) -> dict:
    path = records[0]["client"]
    leaf = records[0].get("client_leaf") or path.split("/")[-1]
    kb: dict = {"onboard": None, "offboard": None}
    actions: list[str] = []
    detected: list[dict] = []
    unmodeled: list[dict] = []
    warnings: list[str] = []
    system_keys: set[str] = set()
    html_blobs: list[str] = []
    order = 0  # document-order index across all sections (for step-by-step reconstruction)

    for rec in records:
        action = "onboarding" if rec.get("action") == "onboarding" else "offboarding"
        kb["onboard" if action == "onboarding" else "offboard"] = rec.get("number")
        if action not in actions:
            actions.append(action)
        if rec.get("latest") is not True:
            warnings.append(f"{action} KB {rec.get('number')} is not marked latest — used best available; verify it's current")
        html_blobs.append(rec.get("body_html", ""))
        for section in split_sections(rec.get("body_html", "")):
            kind, val = classify_header(section.header)
            if kind == "noise":
                continue
            artifacts = extract_artifacts(section.html)  # email templates, attachments
            if kind == "system":
                entry = {
                    "systemKey": val,
                    "action": action,
                    "section": section.raw_header,
                    "seq": order,
                    "confidence": _section_confidence(section, section.text),
                    "mode": CATALOG.get(val, "api"),
                    "signals": extract_signals(val, section),
                    "steps": section.steps,
                }
                if artifacts:
                    entry["artifacts"] = artifacts
                detected.append(entry)
                system_keys.add(val)
            else:
                entry = {"section": section.raw_header, "action": action, "seq": order, "guess": val, "steps": section.steps}
                if artifacts:
                    entry["artifacts"] = artifacts
                unmodeled.append(entry)
            order += 1

    backbone = infer_backbone(system_keys)
    if backbone and backbone.startswith("ad"):
        warnings.append("AD detected; assumed ad-synced (may be ad-standalone) — review backbone.")
    primary_domain = _infer_primary_domain(html_blobs)
    if not primary_domain:
        warnings.append("No primary domain found in runbook — set client.primaryDomain manually.")

    return {
        "irVersion": "1.0",
        "client": {
            "leaf": leaf,
            "path": path,
            "suggestedId": suggest_id(leaf),
            "family": detect_family(path),
            "domainRaw": records[0].get("domain_raw"),
            "primaryDomain": primary_domain,
        },
        "kb": kb,
        "actions": actions,
        "backboneHint": backbone,
        "detected": detected,
        "unmodeled": unmodeled,
        "warnings": warnings,
    }
