import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "consistency-check-cannot-verify",
  date: "2026-08-25",
  time: "10:00",
  title: "The AD/Entra consistency check stops passing what it never checked",
  items: [
    "The check compares an on-prem account's anchor to its Entra object, to catch a hybrid onboard that would create a DUPLICATE. When it had no Entra object to compare against it reported \"no matching Entra object — a fresh sync will create + anchor it (ok)\" — an all-clear for a comparison it had never performed. (FR #0000093)",
    "It now says so: \"could NOT verify the AD/Entra link\", naming why — the 365 step failed, was completed by hand, or did not run — and flags the case instead of quietly passing it",
    "How it happened: the check has no cloud credential, so the app hands it the Entra object read by the Microsoft 365 step. When that step failed and an operator accepted the failure to let the case proceed, the check still ran, was handed a blank object, and could not tell \"there is no cloud object\" from \"nobody looked\"",
    "A genuine no-cloud-object result still passes exactly as before — that one really was checked",
    "Correcting the report that filed this: the check was NOT always reporting no match. Of 39 completed checks, 33 reached a real verdict; the 6 that did not are all cases where the 365 step returned nothing. They were concentrated on one client whose 365 step was failing constantly (now fixed), which is why it looked universal from there",
    "Runner 1.110.0 (Active Directory module) needs deploy",
  ],
};
