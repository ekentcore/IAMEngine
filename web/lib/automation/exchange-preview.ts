// Renders the Exchange Online (EXO V3) cmdlets Coretelligent.Exchange intends to run (mirrors
// runner/modules/Coretelligent.Exchange — offboard only). Pure string templating; no side effects.
import { resolveUpn, type PreviewUser } from "./preview-helpers";

type ExchangeConfig = {
  convertToShared?: { skipIfMailboxOverGB?: number } | null;
  autoReply?: { message?: string } | null;
  forwarding?: { address?: string; keepCopy?: boolean } | null;
  blockMobileDevices?: boolean;
};

export function previewExchange(action: "onboard" | "offboard", config: unknown, _identity: unknown, _domain: string, user?: PreviewUser): string {
  if (action === "onboard") return "# Exchange Online has no onboard lane (the mailbox is created with the M365 user).";
  const cfg = (config ?? {}) as ExchangeConfig;
  const lines = [
    "# --- variables (resolved from the UM case) ---",
    `$Upn = "${resolveUpn(user)}"`,
    "",
    "# --- intended automation (Coretelligent.Exchange — runs BEFORE the m365 license removal) ---",
    "# mailbox size drives the keep-license threshold",
    `$SizeGB = Get-CtgMailboxSizeGB -Identity $Upn`,
  ];
  if (cfg.convertToShared) {
    const t = cfg.convertToShared.skipIfMailboxOverGB ?? 50;
    lines.push("", `# convert to shared unless over ${t} GB (then keep it a licensed user mailbox)`, `if ($SizeGB -le ${t}) { Set-Mailbox -Identity $Upn -Type Shared }`);
  }
  if (cfg.autoReply?.message) lines.push("", "# set out-of-office", `Set-MailboxAutoReplyConfiguration -Identity $Upn -AutoReplyState Enabled -InternalMessage "${cfg.autoReply.message}" -ExternalMessage "${cfg.autoReply.message}"`);
  if (cfg.forwarding?.address) lines.push("", "# forwarding", `Set-Mailbox -Identity $Upn -ForwardingSmtpAddress "${cfg.forwarding.address}" -DeliverToMailboxAndForward:$${cfg.forwarding.keepCopy ? "true" : "false"}`);
  if (cfg.blockMobileDevices !== false) lines.push("", "# block ActiveSync + OWA", `Set-CASMailbox -Identity $Upn -ActiveSyncEnabled $false -OWAEnabled $false`);
  return lines.join("\n");
}
