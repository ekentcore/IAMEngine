import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "spanning-portal-secret-split",
  date: "2026-07-14",
  time: "09:00",
  title: "Spanning: the console sign-in is now its own credential, and Test proves it by actually signing in",
  items: [
    "Spanning needs TWO credentials and they are not interchangeable: the API key (licensing, both onboard and offboard) and an M365 admin sign-in for the admin console (which is what force-sync drives in a browser). They now live in two separate Delinea secrets - 'spanning' and 'spanning-portal'",
    "The portal login is OPTIONAL. Licensing is pure API, so the clients that never force-sync need nothing and stay green - a client with no portal secret simply can't force a sync, and the step says so instead of failing",
    "Test on a client's Spanning system now signs in to the console for real - through Microsoft SSO and the MFA prompt - and triggers nothing. That catches a wrong password, an MFA method Delinea can't mint, Conditional Access blocking the runner, or an admin without console access BEFORE an onboarding needs it. It runs the same flow the force-sync uses, so it can't go green on a credential the real sync would choke on",
    "Only a targeted single-system Test does the real sign-in. Save-and-test, the whole-client run, the fleet button and the nightly sweep never do - one scripted M365 login per client per sweep is exactly the burst that risk-based Conditional Access starts challenging",
    "Set it up: on the spanning-portal secret put Username = an M365 admin's email, Password = that account's password, and enable One-Time Password so Delinea can supply the MFA code at the prompt. It must be a TOTP/authenticator-app method - push and phone-call MFA cannot be automated. See /help/spanning",
    "Guardrail: an M365 password put into the API secret's Username/Password would be sent to Spanning as clientId:clientSecret and 401 every licensing call. Delinea secrets named like 'Spanning Portal' are now filed into the portal slot rather than autofilled into the API slot",
    "Fixed alongside: a swept connection-test failure could go silently un-notified. The sweep marked its rows as swept AFTER creating them, so a row a runner claimed in that window stayed marked 'manual' - and only swept failures raise a notification. It's now set when the row is created",
  ],
};
