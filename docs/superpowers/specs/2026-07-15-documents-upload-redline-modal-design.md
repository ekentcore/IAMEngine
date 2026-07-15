# Documents — progress modal, upload + redline, shrink-proof AI update

Status: approved 2026-07-15. Extends the Documents feature (PR #83).

Four coordinated changes to the in-app reference Documents (`/docs`), sharing one new
**redline** primitive. Docs are stored as Markdown in `DocumentVersion` rows; old versions
are already retained, so nothing here is destructive.

## 1. Shrink-proof AI update

**Problem.** "Update with AI" (`lib/docs/ai-update.ts`) has been dropping large chunks of the
document. Two causes: `MAX_TOKENS = 16000` truncates a large doc mid-body, and the system
prompt only *advises* preserving length.

**Fix (all three).**
- Raise the output cap so a full large doc fits (`MAX_TOKENS` → 32000).
- Rewrite the system prompt: reproduce every heading, paragraph, table row and list item
  **verbatim** unless a change-log entry requires an edit; edits are surgical; explicitly
  forbid summarizing, condensing, or dropping sections.
- **Hard block server-side**, not just the existing UI warning. A shrink check
  (`lib/docs/versioning.ts`, pure + unit-tested) computes the retained ratio
  (`draft.length / current.length`). The publish route rejects a draft below the threshold
  (**0.85**) unless the request carries an explicit `allowShrink: true` (the reviewer ticked
  "I reviewed the removals"). The existing soft banner stays for the 0.85–1.0 band. This moves
  the guard server-side, per the "gated server-side, not in the UI" convention.

## 2. Upload an edited copy (.docx + .md)

Staff download a doc, edit it locally, and upload it back as the next reviewed draft.

- **Formats:** `.docx` (Word round-trip) and `.md`. Convert docx → Markdown via **`mammoth`**
  (docx → HTML) + **`turndown`** (HTML → Markdown). `.md` is taken as-is. Converter lives in
  `lib/docs/import.ts` with the HTML→MD normalization unit-tested.
- **Route:** `POST /api/admin/docs/[slug]/upload` (multipart form-data). Guards on manage-docs.
  Rejects unknown extensions/oversize. Converts → Markdown, then `createDraft({ generatedByAi:
  false })` — the same draft lifecycle the AI path uses (schema already supports non-AI drafts).
- **Review:** identical to the AI draft — redline (upload vs current), change note (auto:
  "Uploaded <filename>"), shrink guard, Publish/Discard.

## 3. Redline any two versions

Promote the diff from draft-only to a first-class compare.

- **Route:** `GET /api/admin/docs/[slug]/redline?from=<versionId>&to=<versionId>` → collapsed
  line diff + stats. Reuses `lib/docs/diff.ts` unchanged. Manager-gated; version-audience
  re-checked. `to` may be `current` and `from` may be omitted (defaults to current) for
  convenience.
- **UI:** version-history rows become selectable (pick *from* / *to*, or "compare to current");
  a **Compare** action renders the redline in a panel using the same diff renderer as the draft
  review.

## 4. Progress modal for "Update with AI"

Replace the single blocking "Generating…" button with a modal (`ai-update-modal.tsx`) that
advances a checklist while the one POST runs:

- **Reading change log** (N entries, known client-side, ticks immediately)
- **Asking the model** (long step; spinner + live elapsed timer + provider name)
- **Parsing response** (ticks on POST resolve)
- **Building redline** (ticks, then the modal hands off to the existing inline diff review)

Steps 1–2 flip client-side on open; 3–4 flip on response. On error the modal shows the message
with Retry. No streaming infrastructure — robust across both provider adapters.

## Data model

**No migration.** `DocumentVersion` already has `generatedByAi`, `markdown`, `changeNote`, the
version chain, and draft/published status. Uploads reuse `generatedByAi: false`; redline reads
existing versions.

## Testing

- Unit: shrink-ratio check (`versioning.test.ts`), docx/html→md normalization (`import.test.ts`).
- Route: upload (docx accepted, md accepted, bad format rejected), publish hard-block
  (blocked < 0.85, allowed with `allowShrink`).
- e2e (worktree dev server + minted session): run an AI update through the modal, upload a
  hand-edited `.md`, redline two versions.

## Shipping

Draft PR from the worktree; append a `web/lib/changelog/entries.ts` entry; no DB migration.
Dependencies added: `mammoth`, `turndown` (+ `@types/turndown`).
