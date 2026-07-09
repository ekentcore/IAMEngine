## Adobe (`adobe`)

`Module: Coretelligent.Adobe` · `Mode: api` · `Build tier: 2` · `Appears in: ~18% on / ~37% off` · `Lanes: both`

Acrobat / Creative Cloud licensing. Higher on offboard (license reclaim). Often
client-managed but we hold admin access.

### Auth
Secret: **`adobe`** — an Adobe **OAuth Server-to-Server** credential (UMAPI v2). The brokered
secret must carry a username/password **and** an `OrgId` field:
- username = **Client ID**, password = **Client Secret**
- field `OrgId` = the Adobe **Organization ID** (looks like `XXXXXXXXXXXXXXXX@AdobeOrg`)

Token is fetched from Adobe IMS (`scope: openid,AdobeID,user_management_sdk`); every action
call also sends `X-Api-Key = client_id`.

### Onboard lane
`always`/`on-request`. Adds the user (by email = `UserPrincipalName`) to the configured
**product profile(s)** — profile membership is what grants the product. Identity itself is NOT
created here (Federated/Enterprise IDs come from the directory); we manage entitlements only.
Idempotent (re-adding is safe).

### Offboard lane
`always`. Removes the user from the **organization** (`removeFromOrg`), which revokes all Adobe
product access. (Asset transfer to a delegate is not yet automated — do it in the Admin Console
if required.)

### Config keys
- `productProfiles` (string[]) — the exact Adobe **Product Profile** names to add on onboard,
  e.g. `["Acrobat Pro - All Apps", "Creative Cloud All Apps"]`. Onboard with an empty/missing
  list is a no-op (nothing to grant).

### Functions
`Connect-CtgAdobe`, `Invoke-CtgAdobeOnboarding`, `Invoke-CtgAdobeOffboarding`, `Get-CtgAdobeUser`,
`Confirm-CtgAdobe` (read-back validator), `Invoke-CtgAdobeAction`.

### Depends on
`m365` / source identity (email). The user's email must already exist in Adobe (synced via the
directory / SSO) for a profile add to land.

### Variants & gotchas
- **Product profile name must match exactly** what the Admin Console shows (Products → product →
  Profiles). A typo silently grants nothing.
- Federated/Enterprise vs Business plans: this module manages *product profiles*, not raw
  products — use the profile names.
- One-time Developer Console credential setup is the real prerequisite (below).
- Asset transfer on removal and license-uptick procurement are NOT implemented — manual.

### Manual fallback
Adobe Admin Console: add the user to the product profile / remove from the org.

---

## Setup — try it end-to-end

**Prereqs:** you're an Adobe **System Administrator**, the runner (central/cloud agent) is
running, and the client already exists in the app.

**1. Create the Adobe Server-to-Server credential**
- Go to the **Adobe Developer Console** → *Create new project* → **Add API** → **User
  Management API** → choose **OAuth Server-to-Server** → assign it an appropriate product
  profile/role.
- From the credential's *Overview* note the **Client ID**, **Client Secret**, and your
  **Organization ID** (`…@AdobeOrg`, shown in Admin Console → Account, or the console).

**2. Find the product-profile name(s) to grant**
- Adobe **Admin Console** → **Products** → pick a product → **Profiles** tab. Copy the profile
  name(s) verbatim (e.g. `Acrobat Pro - All Apps`).

**3. Store the credential in Delinea**
- Create a secret with: **Username** = Client ID, **Password** = Client Secret, and a custom
  field **`OrgId`** = your `…@AdobeOrg` id. Note the Delinea **secret ID**.

**4. Wire it onto the client** — either path:
- *Profile JSON* (`profiles/<client>.json`): add to `secrets`:
  `"adobe": { "provider": "delinea", "id": "<Delinea secret ID>", "label": "Adobe UMAPI" }`,
  then add a system:
  ```json
  { "key": "adobe", "mode": "api", "secrets": ["adobe"], "dependsOn": ["m365"],
    "onboard": { "when": "on-request",
                 "config": { "productProfiles": ["Acrobat Pro - All Apps"] } },
    "offboard": { "when": "always" } }
  ```
  then `npm run db:seed`.
- *Or in the UI*: client → **Edit systems** → add `adobe`, set secret name `adobe`, paste config
  `{ "onboard": { "productProfiles": ["Acrobat Pro - All Apps"] } }`, set lanes, **Save**. Make
  sure the `adobe` secret row exists for the client (add it / re-seed if needed).

**5. Run just the Adobe step**
- Open (or import) an onboard case for that client → in the run report click **“▶ run this step
  only”** on the Adobe step (it runs in isolation, leaving the rest paused — ideal for a first
  test). Or do a **dry-run** case first (`-WhatIf`, no mutations).

**6. Verify**
- The step's read-back (`Confirm-CtgAdobe`) checks the user is present in each configured
  profile. Cross-check in Admin Console → the product profile → the user appears.
- Offboard: re-run on an offboard case and confirm the user is gone from the org.

**Common failures**
- `invalid_client` from IMS → wrong Client ID/Secret, or the secret's username/password are
  swapped.
- Onboard reports "no Adobe product profiles configured" → `config.onboard.productProfiles` is
  empty or under the wrong lane.
- Profile add succeeds but the user has no access → the profile **name** doesn't match the
  Admin Console exactly, or the user's email isn't a known Adobe identity yet (directory sync).
