// The contextual "setup guide" link under a credential's name — shown when the secret needs more
// than a username + password. Shared by the client Secrets panel and the case Credentials panel so
// the wording/affordance can't drift between them. `systems` must be the CLIENT-level wiring (all
// systems referencing the secret), not one case's job list — see secretHelp.
import { secretHelp } from "@/lib/help/secret-help";

export function SecretHelpLink({ name, systems }: { name: string; systems: string[] }) {
  const help = secretHelp(name, systems);
  if (!help) return null;
  return (
    <div style={{ fontSize: 11, marginTop: 2 }}>
      <a href={help.href} target="_blank" rel="noreferrer" title={`Setup guide: ${help.kind} — shows exactly what to set up for this client`}>
        {help.kind} — setup guide ↗
      </a>
    </div>
  );
}
