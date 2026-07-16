import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "m365-perm-probe-flaky-and-optional-caps",
  date: "2026-07-15",
  time: "17:30",
  title: "Microsoft 365 connection test: fix the flaky 'permissions missing' failure, and check the optional MFA-removal permission",
  items: [
    "A Microsoft 365 test could FAIL reporting every Graph permission 'missing' while the Entra test on the SAME credential passed seconds earlier (core1994/JAMS Software saw exactly this). The permissions were actually granted - the test just misread them",
    "Cause: when several M365 tests run together, Microsoft Graph throttles the follow-up calls that translate a permission's id to its name; the probe silently dropped every name it couldn't read and then declared those permissions absent. It now retries the throttled reads, and if it still can't read them it says 'couldn't verify - re-test' instead of failing the test with a false 'missing'",
    "New: the test now also checks UserAuthenticationMethod.ReadWrite.All - the permission that lets an offboard strip a leaver's registered MFA factors (phone, Authenticator, FIDO2) and revoke their sessions. It's marked optional: if it's absent the test NOTES it (shown as '(optional)', not a red failure) and still passes, because offboarding warns and carries on without it",
    "Also checks Domain.Read.All the same optional way - only needed for clients with more than one verified email domain",
    "Agents pick this up on runner 1.64.0",
  ],
};
