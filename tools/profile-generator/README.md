# Profile generator (BUILD_PLAN phase 6 — the fleet generator)

Converts the ServiceNow KB runbook exports in `data/` into **draft** v2 client profiles
(`profiles/_schema.json`), with a per-client confidence score and a "systems detected but
not yet modeled" report. It is the on-ramp for onboarding the ~200-client book without
hand-writing every profile.

It is a **two-stage pipeline over a stable JSON IR seam** so each half uses the right tool
and can grow independently:

```
data/*.jsonl ──▶ extract/ (Python + BeautifulSoup) ──▶ IR (*.ir.json) ──▶ assemble/ (TypeScript + ajv) ──▶ profiles/_drafts/*.json
                  parse messy runbook HTML            ir.schema.json       validate against the v2 schema      + reports/
```

- **extract/** — Python. Turns runbook HTML into structured signals. HTML wrangling is
  Python's strength; this is where the messy parsing lives.
- **assemble/** — TypeScript. Turns IR into a valid v2 profile, validates it against
  `profiles/_schema.json` (the same schema `web/prisma/seed.ts` trusts), scores confidence,
  and writes drafts. Shares the project's TS toolchain.
- **`ir.schema.json`** — the contract between them. Change it and `assemble/src/ir.ts`
  together.

Drafts land in `profiles/_drafts/`. `seed.ts` ignores `_`-prefixed entries, so drafts never
auto-seed and the hand-curated profiles are never touched. Review, then promote a draft by
moving it up to `profiles/`.

## Run

```bash
# one-time setup
cd tools/profile-generator
python3 -m venv .venv && .venv/bin/pip install -r extract/requirements.txt
( cd assemble && npm install )

# generate (slice or full — same tool, a flag)
./run.sh --client "Six One Commodities"     # one client
./run.sh --family cvp                        # a franchise family
./run.sh --slice 8                           # representative sample
./run.sh --all                               # the whole book
./run.sh --all --report-only                 # just the unmodeled-systems report, no profiles
./run.sh --slice 8 --diff-curated            # diff output against the 5 hand-curated profiles
```

`run.sh` chains the two stages and passes flags through. To run a stage alone:

```bash
.venv/bin/python -m kbgen.cli --slice 8 --out out/ir      # extract -> out/ir/*.ir.json
( cd assemble && npm run assemble -- --ir ../out/ir --out ../../../profiles/_drafts )
```

## How to extend (the part that matters)

**Teach it a new system** (e.g. you want to model Salesforce):
1. Add the key + default mode to `CATALOG` in `extract/kbgen/catalog.py`.
2. Add header alias(es) to `SECTION_ALIASES` in the same file (most-specific first).
3. (Optional) For structured config — licenses, groups, OU, guardrails — register a rich
   extractor in `extract/kbgen/extractors/` and add it to the registry. Otherwise the
   system gets a presence signal with a default lane.
4. (Optional) Map IR `signals` keys into profile config in `assemble/src/assemble.ts`.

**Find what to model next:** run `./run.sh --all --report-only` and read
`out/reports/unmodeled.md` — it ranks every detected-but-unmodeled section by client count.
That is the prioritised backlog.

**Add a franchise template:** drop a partial profile in `assemble/templates/<family>.json`
and register the family's path prefix in `extract/kbgen/families.py`.
