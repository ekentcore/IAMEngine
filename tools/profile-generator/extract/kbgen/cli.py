"""Extraction stage CLI: KB JSONL -> per-client IR (*.ir.json) + unmodeled report.

  python -m kbgen.cli --slice 8
  python -m kbgen.cli --client "Six One"
  python -m kbgen.cli --family cvp
  python -m kbgen.cli --all --report-only
"""
from __future__ import annotations

import argparse
import json
from collections import Counter, defaultdict
from pathlib import Path

from .build import build_client_ir
from .families import detect_family
from .loader import best_per_action, group_by_client, load_records
from .scope import is_offboard_only, parked_reason

TOOL_ROOT = Path(__file__).resolve().parents[2]
REPO_ROOT = Path(__file__).resolve().parents[4]

# leaves that seed a --slice sample (curated clients + one of each family for coverage)
SLICE_SEEDS = ["six one", "regal", "yuma", "marketscience", "raith"]


def select(groups: dict[str, list[dict]], args) -> list[str]:
    paths = list(groups.keys())
    if args.client:
        needle = args.client.lower()
        return [p for p in paths if needle in p.lower()]
    if args.family:
        return [p for p in paths if detect_family(p) == args.family]
    if args.slice:
        return _slice(paths, args.slice)
    return sorted(paths)


def _slice(paths: list[str], n: int) -> list[str]:
    chosen: list[str] = []
    for seed in SLICE_SEEDS:
        for p in paths:
            if seed in p.lower() and p not in chosen:
                chosen.append(p)
                break
    for fam in ("cvp", "olympus"):
        for p in sorted(paths):
            if detect_family(p) == fam and p not in chosen:
                chosen.append(p)
                break
    for p in sorted(paths):
        if len(chosen) >= n:
            break
        if p not in chosen:
            chosen.append(p)
    return chosen[:n]


def write_unmodeled_report(irs: list[dict], path: Path) -> None:
    # group by guess (falls back to the raw section text) -> set of client leaves
    clients: dict[str, set[str]] = defaultdict(set)
    sections: dict[str, set[str]] = defaultdict(set)
    for ir in irs:
        leaf = ir["client"]["leaf"]
        for u in ir["unmodeled"]:
            label = u["guess"] or u["section"]
            clients[label].add(leaf)
            sections[label].add(u["section"])
    rows = sorted(clients.items(), key=lambda kv: len(kv[1]), reverse=True)
    lines = [
        "# Systems detected but not yet modeled",
        "",
        f"Across {len(irs)} clients. Ranked by client count — this is the backlog of "
        "extractors to write next (see tools/profile-generator/README.md).",
        "",
        "| detected system / section | # clients | sample sections | sample clients |",
        "|---|---:|---|---|",
    ]
    for label, cset in rows:
        samp_sec = ", ".join(sorted(sections[label])[:3])
        samp_cli = ", ".join(sorted(cset)[:4])
        lines.append(f"| {label} | {len(cset)} | {samp_sec} | {samp_cli} |")
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def print_summary(irs: list[dict]) -> None:
    backbones = Counter(ir["backboneHint"] for ir in irs)
    fam = Counter(ir["client"]["family"] for ir in irs if ir["client"]["family"])
    confs = [d["confidence"] for ir in irs for d in ir["detected"]]
    avg = round(sum(confs) / len(confs), 2) if confs else 0.0
    with_warn = sum(1 for ir in irs if ir["warnings"])
    print(f"  clients:            {len(irs)}")
    print(f"  backbone hints:     {dict(backbones)}")
    print(f"  families:           {dict(fam)}")
    print(f"  avg signal conf.:   {avg}")
    print(f"  clients w/ warnings:{with_warn}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="kbgen", description="Extract KB runbooks into profile-generator IR.")
    sel = ap.add_mutually_exclusive_group()
    sel.add_argument("--client", help="substring match on client path/leaf")
    sel.add_argument("--family", choices=["cvp", "olympus"])
    sel.add_argument("--slice", type=int, metavar="N", help="representative sample of N clients")
    sel.add_argument("--all", action="store_true", help="every in-scope client (default)")
    ap.add_argument("--data", default=str(REPO_ROOT / "data"), help="dir with onboarding/offboarding.jsonl")
    ap.add_argument("--out", default=str(TOOL_ROOT / "out" / "ir"), help="dir for *.ir.json")
    ap.add_argument("--reports", default=str(TOOL_ROOT / "out" / "reports"))
    ap.add_argument("--report-only", action="store_true", help="write only the unmodeled report")
    ap.add_argument("--include-parked", action="store_true", help="do not skip parked/out-of-scope clients")
    args = ap.parse_args(argv)

    data = Path(args.data)
    # Load all versions; best_per_action picks the latest (or best available) per client+action.
    onb = load_records(data / "onboarding.jsonl")
    off = load_records(data / "offboarding.jsonl")
    groups = group_by_client(onb, off)

    selected = select(groups, args)
    skipped: list[tuple[str, str]] = []
    irs: list[dict] = []
    for path in selected:
        reason = parked_reason(path)
        if reason and not args.include_parked:
            skipped.append((path, reason))
            continue
        records = best_per_action(groups[path])
        if is_offboard_only(path):
            records = [r for r in records if r.get("action") == "offboarding"]
            if not records:
                skipped.append((path, "offboard-only but no offboard KB"))
                continue
        irs.append(build_client_ir(records))

    out_dir = Path(args.out)
    reports_dir = Path(args.reports)
    reports_dir.mkdir(parents=True, exist_ok=True)
    if not args.report_only:
        out_dir.mkdir(parents=True, exist_ok=True)
        # clear stale IR so the dir reflects only this selection (the assembler reads all of it)
        for stale in out_dir.glob("*.ir.json"):
            stale.unlink()
        for ir in irs:
            (out_dir / f"{ir['client']['suggestedId']}.ir.json").write_text(
                json.dumps(ir, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    write_unmodeled_report(irs, reports_dir / "unmodeled.md")

    print(f"Extracted {len(irs)} clients" + ("" if args.report_only else f" -> {out_dir}"))
    if skipped:
        print(f"Skipped {len(skipped)} parked/out-of-scope: " +
              ", ".join(f"{Path(p).name} ({r})" for p, r in skipped[:6]) +
              (" ..." if len(skipped) > 6 else ""))
    print_summary(irs)
    print(f"Unmodeled report: {reports_dir / 'unmodeled.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
