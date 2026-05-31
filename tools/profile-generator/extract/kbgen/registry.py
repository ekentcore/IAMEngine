"""Signal-extractor registry. Every detected section gets base signals (when / evidence /
approval / schedule); systems with a registered rich extractor get structured config
hints on top (licenses, groups, OU, guardrails). Register a new one with @register('key').
"""
from __future__ import annotations

import re
from typing import Callable

from .sectioning import Section

SignalFn = Callable[[Section], dict]
SIGNAL_EXTRACTORS: dict[str, SignalFn] = {}


def register(system_key: str) -> Callable[[SignalFn], SignalFn]:
    def deco(fn: SignalFn) -> SignalFn:
        SIGNAL_EXTRACTORS[system_key] = fn
        return fn
    return deco


_ON_REQUEST = re.compile(r"if requested|if applicable|if needed|optional|as needed|as requested", re.I)
_SCHEDULE = re.compile(r"after (\d+)(?:\s*[-–]\s*(\d+))?\s*days", re.I)


def base_signals(section: Section) -> dict:
    sig: dict = {}
    sig["when"] = "on-request" if _ON_REQUEST.search(section.raw_header) else "always"
    t = section.text.lower()
    if "screenshot" in t or "capture evidence" in t:
        sig["captureEvidence"] = True
    if "written approval" in t or "poc approval" in t or "requires approval" in t:
        sig["requiresApproval"] = True
    m = _SCHEDULE.search(t)
    if m:
        lo = int(m.group(1))
        hi = int(m.group(2)) if m.group(2) else lo
        sig["schedule"] = {"offsetDaysMin": lo, "offsetDaysMax": hi}
    return sig


def extract_signals(system_key: str, section: Section) -> dict:
    sig = base_signals(section)
    fn = SIGNAL_EXTRACTORS.get(system_key)
    if fn:
        sig.update(fn(section))
    return sig


# Importing the package registers the rich extractors via @register side-effects.
from . import extractors  # noqa: E402,F401
