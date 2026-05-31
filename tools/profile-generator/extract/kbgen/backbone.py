"""Infer the identity backbone from the set of detected systems.

This is a *hint* for the assembler to be reviewed by a human, not ground truth:
ad-synced vs ad-standalone in particular cannot be told apart from the runbook headers
alone, so AD-present defaults to ad-synced (the common case) and emits a warning.
"""
from __future__ import annotations


def infer_backbone(system_keys: set[str]) -> str | None:
    if "google-workspace" in system_keys and "active-directory" not in system_keys:
        return "google"
    if "directory-sync" in system_keys:
        return "ad-synced"
    if "active-directory" in system_keys:
        return "ad-synced"  # ad-standalone is rare; flag for review rather than guess
    if {"m365", "entra", "exchange"} & system_keys:
        return "entra"
    return None
