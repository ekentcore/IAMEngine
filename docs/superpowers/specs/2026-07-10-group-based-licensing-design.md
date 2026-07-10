# Group-based license assignment — design

Approved 2026-07-10 (Evan). Context: INC0858242 — Coretelligent licenses via Entra group
membership, and the profile carried a stale hand-pasted group GUID that Graph 404'd.

## What

Let an operator mark a default M365 license as **Group based** and pick the carrying group
from the client's discovered groups (Entra + on-prem AD, labeled by source) — the same
suggestion data the rules editor uses. One group per license entry; multiple entries allowed.

## Config shape

`ClientSystem.config.onboard.licenses` stays one list. A **string** entry is unchanged
(direct `Set-MgUserLicense`). A group-based entry is an object:

```json
{ "name": "Microsoft 365 E5", "assignVia": "group",
  "group": "E5 License Users", "groupSource": "entra" }
```

- `group` is the **name** (a GUID is also accepted and verified). Names are resolved live at
  execution — a rename/deletion produces a clear actionable error instead of a silent stale id.
- `groupSource`: `"entra"` (default) or `"ad"`.

## Execution split

- **Entra-source** entries run in the m365 lane: resolve name → id (`Get-MgGroup`), then the
  existing idempotent `Add-CtgGroupMember`. Excluded from the direct `Set-MgUserLicense`
  batch/loop. usageLocation is still set (group licensing requires it too).
- **AD-source** entries are appended to the **active-directory job's `groups` list at plan
  time** by the orchestrator — the AD lane already adds groups idempotently and runs before
  m365. No runtime handoff (note: seat-aware's `LicenseFallbackAdGroup` runtime handoff is
  surfaced on the result but consumed by nothing; plan-time avoids repeating that).

## Validation

`Confirm-CtgM365`: an entra-source group-based entry verifies **group membership** (reusing
the normalized membership index), not direct sku presence — sku propagation lags membership.
An ad-source entry reports informational pass (the AD lane's validator owns on-prem groups).

## Seat-aware (kept separate, per decision)

`Set-CtgSeatAwareLicense`'s `entraGroupWhenAvailable` / `entraGroupFallback` gain the same
name-or-GUID resolution, so the fragile-GUID failure mode is gone there too. Editor UI for
seat-aware config: out of scope this pass (config remains profile/DB-authored).

## UI

`m365-license-editor.tsx`: each selected license gets a Direct / Group based toggle;
Group based reveals a single-group picker (new small `GroupPicker`, same normalization/
suggestion behavior as the rules editor's `TagList`, options labeled Entra/AD) fed by
`Client.adObjects.groups` + `Client.cloudGroups.groups` from the detail-page loader. Empty
inventory shows a "run Discover cloud groups" hint. Save route
`POST /api/clients/[slug]/m365-licenses` validates the extended shape.

## Out of scope

Auto-triggering cloud-group discovery; unifying seat-aware with group-based; a seat-aware
editor UI; migrating existing profiles (string entries keep working).
