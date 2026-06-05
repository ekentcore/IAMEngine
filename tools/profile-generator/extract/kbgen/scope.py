"""In-scope filtering. Mirrors the scope decisions in CLAUDE.md. No structured 1/2/3
rating exists in the data, so scope = has-a-latest-KB minus this parked/out-of-scope set.
"""
from __future__ import annotations

# substring (lowercased) -> reason. These are skipped unless --include-parked.
PARKED: list[tuple[str, str]] = [
    ("pgls", "out of scope (ignore entirely)"),
    ("boys & girls club", "parked: missing offboard doc"),
    ("boys and girls club", "parked: missing offboard doc"),
    ("atlanta opera", "parked: doc needs cleanup"),
    # Coretelligent is the MSP, not a client. KB articles filed under the "Coretelligent"
    # company are actually OTHER clients' guides (e.g. Triangle Veterinary, YMCA Atlanta), so
    # grouping them by client_leaf makes a nonsense merged profile. Coretelligent's own internal
    # onboarding is hand-authored (profiles/coretelligent.json), not KB-generated.
    ("coretelligent", "the MSP itself — internal onboarding is hand-authored, not KB-generated"),
]

# clients we only generate the offboard lane for.
OFFBOARD_ONLY: list[str] = ["institute on aging"]


def parked_reason(path: str) -> str | None:
    p = (path or "").lower()
    for needle, reason in PARKED:
        if needle in p:
            return reason
    return None


def is_offboard_only(path: str) -> bool:
    p = (path or "").lower()
    return any(n in p for n in OFFBOARD_ONLY)
