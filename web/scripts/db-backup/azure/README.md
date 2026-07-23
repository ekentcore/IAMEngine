# Azure Blob off-box backup — cutover runbook (feature #5, Phase 2)

Off-box upload SHIPS DARK. Nothing in the app calls Azure until `backup.azure.enabled` is set to
`true` (default off). Pre-migration the local `pg_dump` machinery is untouched; the restore drill
(Phase 1) already runs against the local `latest.dump`.

Provision ONCE at/after the Azure cutover, then flip the switch:

1. **Storage account + container** — private access only (no anonymous/public), encryption at rest
   (default on). Consider a private endpoint if the VNet allows it. The dump holds the full client
   roster + case + audit history — treat the container as confidential.

2. **Auth (design §3.2, D2), in preference order:**
   - **Managed identity (no secret):** grant the app VM's system-assigned identity
     `Storage Blob Data Contributor` on the container. Set `backup.azure.credentialRef` to the
     sentinel `"managed-identity"` (the default) → the CLI uses `--auth-mode login`.
   - **Delinea-brokered SAS (fallback):** store a connection string / SAS as a Delinea secret and set
     `backup.azure.credentialRef` to its external id. The app brokers it at run time and never
     persists it. NEVER put a key or SAS string into AppSetting, a profile, or code.

3. **Lifecycle policy** — age dumps out in Blob (not by the app deleting blobs):
   ```
   az storage account management-policy create \
     --account-name <acct> --resource-group <rg> --policy @lifecycle-policy.json
   ```
   Edit the `delete` day count to match `backup.azure.retentionDays` (default 90).

4. **Set the AppSettings** (all under `backup.azure`): `enabled`, `account`, `container`,
   `credentialRef`, `retentionDays`, optional `localKeepDays`. The drill schedule lives under
   `backup.azure.drill`.

5. **Validate on the VM:** run a manual backup, confirm the blob lands, the recorded checksum matches,
   the drill can download-and-restore the Blob copy, and the lifecycle policy is applied. Keep any test
   output OUT of git (an inventory report once leaked a client roster).
