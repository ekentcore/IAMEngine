# Import clients by CORE id — design

Date: 2026-07-13

## Problem

Adding a client today is a manual, multi-screen chore: open "Add client", type the name,
primary domain and (optionally) the CORE id, save — then open the new client, find its KB
number, fetch it, review the parse, save, and repeat for the other lifecycle action. The
roster sync creates clients from ServiceNow, but a roster-created client is a bare row: no
runbook, no systems, so its cases plan zero steps.

We want one input: a CORE id, or a comma-separated list of them. Everything else — the
ServiceNow record, the KB articles, the runbook sections, the client systems — is resolved
and built automatically.

## Behaviour

Input: free text containing CORE ids separated by commas (whitespace/newlines also
tolerated). `CORE1269`, `core1269` and `1269` all normalize to `CORE1269`.

Per id, in order:

1. **Resolve** — `fetchSnAccountByCoreId`. No match in ServiceNow → `not_found`. An account
   without a `sys_id` is an error: every downstream key hangs off it.
2. **Already known?** — three lookups, because a client can predate any one of them: its
   `coreId`, the `serviceNowSysId` the account resolves to (roster-synced rows may carry no
   CORE id), and — for a profile-seeded row that has *neither* — its `primaryDomain`.
   Skipping the domain check is how you get two `Client` rows for one company, with the
   original holding the systems, credentials and case history. Only a domain that maps to
   exactly one client counts; an ambiguous one falls through to create, because mis-linking
   is worse than a new row. This is the rule `syncClientsFromSn` already follows.
3. **Create or adopt** — a new client: `repo.createFromSn` (idempotent on `serviceNowSysId`),
   slug from the CORE id (`core1269`), plus a `client.create` audit row with
   `source: "import"`. An existing one: stamp the ServiceNow keys onto it (never over a
   field a human edited — `editedFields`) and carry on to the build.
4. **Link the parent** — `createFromSn` does not set `parentId` (the roster sync links
   parents in a second pass, since a child can arrive before its parent). Without this an
   imported child's cases plan *zero steps* while the UI claims it inherits the parent's
   systems.
5. **Discover KBs** — see below. Zero found → the client still exists; the row carries a
   warning and the operator builds it by hand.
6. **Build the actions that have no runbook** — `fetchKbArticle` → `extractRunbookAI`
   (heuristic parse as fallback) → `saveRunbook`, which recreates the `RunbookSection` rows
   and auto-creates the missing `ClientSystem` rows from catalog defaults.

**What "already in the system" does and does not protect.** `saveRunbook` *replaces* an
action's sections, so an action that already has a runbook is never rebuilt — that is the
promise, and it is what protects an operator's edits. But refusing to touch the *client*
would make this feature a no-op for almost the entire fleet: opening the clients list runs
`syncIfStale`, so nearly every in-scope client already exists as a **bare roster row** — no
runbook, no systems, cases that plan zero steps. Those bare rows are exactly the problem
this feature exists to solve. So an existing client's **empty** actions are built, and its
**populated** ones are left strictly alone.

A failure at 5 or 6 does not roll back 3. The client is created and *named on the result
row* (an anonymous "Failed" would hide a client that now exists), and the failure lands as
a warning. Re-running finishes the job — the empty actions are still empty, so they build.

## KB discovery

Verified against the live instance: `customer_account.sys_domain` is the client's
ServiceNow domain (e.g. `TOP/Digital Currency Group, Inc.`), and `kb_knowledge` rows for
that client carry the same `sys_domain`. This is the same grouping key the static KB corpus
(`data/*.jsonl`, field `domain_raw`) was built on, so it is the reliable link from account
to KB — there is no direct account→article reference field.

Querying by domain alone is not enough. The domain also holds the client's PDFs,
spreadsheets and .docx uploads, several of which have "Onboarding" in the title
(`Pacific Lake Partners - Onboarding_Docs.docx`), and `article_type` is `text` for all of
them, so type cannot discriminate. Titles of the real guides vary in shape:

- `New User Onboarding Guide - Sporos Bioventures, Inc.`
- `Bernville Veterinary Clinic - User Onboarding Guide`
- `New Onboard User Guide - Digital Currency Group`
- `User Offboarding Guide` (no client name at all — identified only by its domain)

So discovery scores candidates rather than pattern-matching one title:

- Ask ServiceNow only for the *boarding* articles in the domain
  (`short_descriptionLIKEboard`). A big client's domain holds hundreds of rows — every
  article, times every revision — enough to push the guide past any row limit. "board"
  catches Onboarding / Offboarding / Off-Boarding / New Onboard alike; the odd
  Dashboard/Keyboard hit is dropped by the scoring anyway.
- Reject titles that look like an uploaded file (`.docx`, `.pdf`, `.xlsx`, `.msg`, …).
- Classify by which of onboard/offboard the title mentions (a title mentioning both, or
  neither, is not a candidate for either action).
- Score: contains "guide" (strong), lives in the client's own KB base rather than the
  shared "Co-Managed IT" base, `latest`, `published`, most recently updated. Keep only the
  best row per KB number — `kb_knowledge` stores every revision as its own row.
- Best-scoring candidate per action wins; the others are returned so the UI can say a
  choice was made among several.

**A pick that isn't a guide is not imported.** Century Equity has no onboarding guide at
all — only an "Offboard User Request" form. Saving that as the runbook would create
`ClientSystem` rows out of whatever the extractor made of the form's prose, and a live case
would then dispatch jobs against systems the client may not even own. So a low-confidence
pick (no "guide" in the title) is *named on the result row for a human to review*, not
saved. The client page's Fetch button takes it from there.

Published articles are queried first; if an action has no published candidate, unpublished
ones are considered (some clients' only onboarding guide is not the published revision —
the same reason `best_per_action` exists in the profile generator).

## Shape of the code

- `web/lib/servicenow/kb-discovery.ts` — `findClientKbs(config, domainSysId, fetcher)`,
  returning `{ onboard, offboard, candidates }`. Pure over an injected fetcher; the title
  scoring is exported separately so it can be unit-tested without HTTP.
- `web/lib/clients/import-by-coreid.ts` — `normalizeCoreId`, `parseCoreIds` (the textarea
  parser: split, normalize, de-duplicate) and `importClientByCoreId(deps, coreId)`. All
  I/O is injected (`deps`), so the orchestration unit-tests without ServiceNow, Azure or a
  database — the pattern `sync-service.ts` already uses.
- `web/lib/servicenow/gateway.ts` — add `sys_domain` to the account field list (needed by
  discovery; harmless to the existing roster sync).
- `web/app/api/clients/import/route.ts` — `POST { coreIds }`, guarded by
  `client.edit_systems`. Streams one NDJSON line per completed id.
- `web/app/clients/_components/add-client-dialog.tsx` — CORE id import becomes the primary
  path; the existing manual name/domain form stays, behind a disclosure, for clients that
  are not in ServiceNow.

## Why streaming

A build is up to two KB fetches plus two AI extractions per client, so twenty ids is
minutes of work. A single request that returns only at the end gives the operator a spinner
with no idea whether it is progressing or hung. Streaming NDJSON, one line per finished id,
gives a live-filling summary table for the cost of a `ReadableStream` — much less machinery
than putting this on the `Job` queue, which is designed for runner dispatch, not in-app
work. Ids are processed sequentially: it keeps ServiceNow and Azure OpenAI load flat and
makes the stream a readable progress log.

The batch is capped (25 ids) so a paste of the whole roster cannot pin the server.

## Result UX

Each streamed row: CORE id, client name, status (`imported` / `exists` / `not_found` /
`error`), the KBs used, the count of runbook sections and created systems, and any warning.

- Exactly one id, imported successfully → navigate to `/clients/<slug>` to examine it.
- Anything else (many ids, or a single id that already existed / failed) → the summary
  table stays on screen, each imported/existing client linking to its page.

## Testing

- `kb-discovery.test.ts` — scoring and selection: both title orders, the "New Onboard User
  Guide" shape, attachment rejection, a title with no client name, no-candidate case,
  published-then-unpublished fallback.
- `import-by-coreid.test.ts` — id normalization and parsing (`core1269`, `1269`, blanks,
  duplicates); exists-by-coreId, exists-by-sysId, not-found, happy path (both actions
  built), KB-fetch failure leaves the client created with a warning, AI failure falls back
  to the heuristic parse.
