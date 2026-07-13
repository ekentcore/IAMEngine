import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClientFolderName, normalizeClientName, classifySecret, rankCandidates, candidatesBySlot, shouldAutofill } from "./recovery-match";
import type { SecretSearchRecord } from "./delinea-search";

const rec = (name: string, over: Partial<SecretSearchRecord> = {}): SecretSearchRecord => ({
  id: 1,
  name,
  folderPath: "\\Clients\\Six One Commodities LLC !CORE1087!\\Identity Services",
  ...over,
});

const slots = (name: string, over: Partial<SecretSearchRecord> = {}) => classifySecret(rec(name, over)).map((c) => `${c.slot}:${c.tier}`);

test("parseClientFolderName extracts the CORE id and display name", () => {
  assert.deepEqual(parseClientFolderName("ACORE Capital, LP !CORE507!"), { coreId: "CORE507", displayName: "ACORE Capital, LP" });
  assert.deepEqual(parseClientFolderName("BayPine Capital !CORE1186!"), { coreId: "CORE1186", displayName: "BayPine Capital" });
  assert.deepEqual(parseClientFolderName(".406 Ventures !CORE61!"), { coreId: "CORE61", displayName: ".406 Ventures" });
  // tolerant of case and stray whitespace inside the tag
  assert.equal(parseClientFolderName("Foo ! core 123 !")?.coreId, "CORE123");
  assert.equal(parseClientFolderName("Acme Corp. (Nathan Demo Account)"), null);
  assert.equal(parseClientFolderName("Admin - Client (Local)"), null);
});

test("normalizeClientName is case/punctuation/suffix-blind", () => {
  assert.equal(normalizeClientName("ACORE Capital, LP"), normalizeClientName("Acore capital"));
  assert.equal(normalizeClientName("Six One Commodities LLC"), normalizeClientName("Six One Commodities"));
});

test("the platform's own secret names classify high", () => {
  assert.deepEqual(slots("IAM Engine"), ["m365-admin:high"]);
  assert.deepEqual(slots("Mimecast API"), ["mimecast:high"]);
  assert.deepEqual(slots("Spanning API"), ["spanning:high"]);
  assert.deepEqual(slots("Perimeter81 API"), ["perimeter81:high"]);
  assert.deepEqual(slots("S1_API integration"), ["sentinelone:high"]);
});

test("automation templates classify high even without an API word in the name", () => {
  assert.deepEqual(slots("CoreAutomation - Mimecast", { secretTemplateName: "Automation - Api" }), ["mimecast:high"]);
  assert.deepEqual(slots("CoreAutomation - Azure Authentication", { secretTemplateName: "Automation - Azure App" }), ["m365-admin:high"]);
  assert.deepEqual(slots("CoreAutomation", { secretTemplateName: "Automation - Azure App" }), ["m365-admin:high"]);
});

test("human M365 GA accounts are medium, not high", () => {
  assert.deepEqual(slots("cicwealth.com - Office 365 GA - Coretelligent"), ["m365-admin:medium"]);
  assert.deepEqual(slots("IAM Engineer"), ["m365-admin:medium"]);
});

test("plain system mentions without an API qualifier are medium", () => {
  assert.deepEqual(slots("Sentinel (ITG)"), ["sentinelone:medium"]);
  const c = classifySecret(rec("Sentinel (ITG)"))[0];
  assert.equal(c.stale, true); // (ITG) marks the prior MSP's credential
});

test("mail-flow and hardware accounts that mention a system are not candidates", () => {
  assert.deepEqual(slots("Mimecast Scan to Email Account"), []);
  assert.deepEqual(slots("Password Expiration Mimecast SMTP Address passwordexpirations@x.com"), []);
  assert.deepEqual(slots("61C Stamford Office Wifi"), []);
});

test("two specific products in one name is ambiguous and never high", () => {
  const cands = classifySecret(rec("Adobe / Zoom Admin"));
  assert.equal(cands.length, 2);
  for (const c of cands) {
    assert.equal(c.ambiguous, true);
    assert.equal(c.tier, "medium");
    assert.equal(shouldAutofill(c, true), false); // a shared two-product login is never auto-assigned
  }
});

// A generic "365"/"O365"/"Azure" mention describes the TENANT the credential administers or backs
// up — it must not make a specific product ambiguous. Counting it stranded 36 spanning slots.
test("a generic 365/Azure mention does not make a product credential ambiguous", () => {
  const [spanning] = classifySecret(rec("Spanning O365"));
  assert.equal(spanning.slot, "spanning");
  assert.equal(spanning.ambiguous, false);
  assert.equal(shouldAutofill(spanning, true), true);
});

test("stale candidates rank behind live ones; Identity Services beats Vendor", () => {
  const live = classifySecret(rec("Mimecast API", { id: 10 }))[0];
  const stale = classifySecret(rec("Mimecast Basic Administrator (INACTIVE)", { id: 11, folderPath: "\\Clients\\X !CORE1!\\Vendor" }));
  const vendorApi = classifySecret(rec("Mimecast API", { id: 12, folderPath: "\\Clients\\X !CORE1!\\Vendor" }))[0];
  const ranked = rankCandidates([...stale, vendorApi, live]);
  assert.equal(ranked[0].record.id, 10); // live + high + Identity Services
  assert.equal(ranked[1].record.id, 12); // live + high, Vendor
});

// The false positives a bare token scan produces — each of these was really chosen by an earlier
// version of the matcher against the live vault, and each would be a wrong credential.
test("device/mail-flow/per-person accounts never become candidates", () => {
  assert.deepEqual(slots("Zoom Room - Concord - iPad Passcode"), []);
  assert.deepEqual(slots("Zoom Room Account"), []);
  assert.deepEqual(slots("Egnyte Morgan Stanly SFTP password"), []);
  assert.deepEqual(slots("Trystan Egnyte Non-SSO"), []);
  assert.deepEqual(slots("MimecastLdap Service account"), []);
  assert.deepEqual(slots("Mimecast DMARC Analyzer"), []);
  assert.deepEqual(slots("Scan SVC Account"), []);
  assert.deepEqual(slots("MaaS360 Service Account"), []);
});

test("ad-dc only matches a named automation/IAM account, not any service account", () => {
  assert.deepEqual(slots("SVC-Scriptrunner", { secretTemplateName: "Active Directory Account" }), ["ad-dc:medium"]);
  assert.deepEqual(slots("IAM AD Service Account"), ["ad-dc:medium"]);
  // a generic vendor service account must NOT be offered as the AD credential
  assert.deepEqual(slots("Interaction AD with Mailbox for Synchronization Service(s)"), []);
  assert.deepEqual(slots("Entrust Service Account - Azure-Entrust"), []);
});

test("write policy: high auto-fills; medium only for fail-closed cloud systems; never ad-dc or stale", () => {
  const [mimecastHigh] = classifySecret(rec("Mimecast API", { secretTemplateName: "Automation - Api" }));
  assert.equal(shouldAutofill(mimecastHigh, true), true);

  const [m365Med] = classifySecret(rec("Office 365 Global Admin"));
  assert.equal(m365Med.tier, "medium");
  assert.equal(shouldAutofill(m365Med, true), true);   // cloud + verified -> safe to write
  assert.equal(shouldAutofill(m365Med, false), false); // unverified medium is never written

  const [adMed] = classifySecret(rec("SVC-Scriptrunner", { secretTemplateName: "Active Directory Account" }));
  assert.equal(adMed.slot, "ad-dc");
  assert.equal(shouldAutofill(adMed, true), false); // AD is destructive — a guess is suggest-only

  const staleHigh = classifySecret(rec("Mimecast API (INACTIVE)", { secretTemplateName: "Automation - Api" }))[0];
  assert.equal(staleHigh.stale, true);
  assert.equal(shouldAutofill(staleHigh, true), false);
});

test("candidatesBySlot groups a realistic folder correctly", () => {
  const records: SecretSearchRecord[] = [
    rec("IAM Engine", { id: 56880, secretTemplateName: "Entra Azure AD Account" }),
    rec("Mimecast API", { id: 56882, secretTemplateName: "Automation - Api" }),
    rec("Spanning API", { id: 56881, secretTemplateName: "Automation - Api" }),
    rec("Perimeter81 API", { id: 56883, secretTemplateName: "Automation - Api" }),
    rec("S1_API integration", { id: 39539, folderPath: "\\Clients\\X !CORE1!\\Vendor", secretTemplateName: "Import" }),
    rec("Mimecast Partner Administrator Account", { id: 39534, folderPath: "\\Clients\\X !CORE1!\\Vendor", secretTemplateName: "Import" }),
    rec("61C-HOU-FW01", { id: 56094, folderPath: "\\Clients\\X !CORE1!\\Networking", secretTemplateName: "Firewall" }),
  ];
  const by = candidatesBySlot(records);
  assert.equal(by.get("m365-admin")?.[0].record.id, 56880);
  assert.equal(by.get("mimecast")?.[0].record.id, 56882);
  assert.equal(by.get("spanning")?.[0].record.id, 56881);
  assert.equal(by.get("perimeter81")?.[0].record.id, 56883);
  assert.equal(by.get("sentinelone")?.[0].record.id, 39539);
  assert.equal(by.has("ad-dc"), false);
});
