"""Load and group the KB JSONL exports."""
from __future__ import annotations

import json
from pathlib import Path


def load_records(path: str | Path) -> list[dict]:
    return [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]


def latest_only(records: list[dict]) -> list[dict]:
    return [r for r in records if r.get("latest") is True]


def group_by_client(*record_lists: list[dict]) -> dict[str, list[dict]]:
    """Group records by full client path (the unique key). Onboarding + offboarding for the
    same client land in the same group."""
    groups: dict[str, list[dict]] = {}
    for records in record_lists:
        for r in records:
            groups.setdefault(r["client"], []).append(r)
    return groups
