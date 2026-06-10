// Which credentials need more than a username + password, and where their setup guide lives.
// Used by the client + case credential panels to show a contextual "setup guide" button — the
// link itself carries what the operator needs (e.g. cloud vs hybrid), so the guide can show only
// the relevant steps instead of making them work out whether a certificate is needed.
// Add an entry when a new help page ships; secrets not listed here are plain username/password
// (or have no guide yet) and get no button.

export type SecretHelp = { kind: string; href: string };

export function secretHelp(name: string, systems: string[]): SecretHelp | null {
  if (name === "m365-admin") {
    // Hybrid (an exchange step uses this secret) needs the certificate; cloud-only needs just the
    // app registration + client secret. The query string picks the right variant of the guide.
    const hybrid = systems.includes("exchange");
    return hybrid
      ? { kind: "app registration + certificate", href: "/help/cloud-auth?type=hybrid" }
      : { kind: "app registration", href: "/help/cloud-auth?type=cloud" };
  }
  if (name === "spanning") {
    return { kind: "API key", href: "/help/spanning" };
  }
  if (name === "mimecast") {
    return { kind: "API 2.0 application (client ID + secret)", href: "/help/mimecast" };
  }
  if (name === "egnyte") {
    return { kind: "API token", href: "/help/egnyte" };
  }
  return null;
}
