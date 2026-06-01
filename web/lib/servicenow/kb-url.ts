// Build a ServiceNow KB article URL from the instance base + article number.
// Returns null when we have no instance configured or no article number, so the UI can
// simply omit the link.
export function kbUrl(articleNumber: string | null | undefined, instanceUrl = process.env.SN_INSTANCE_URL): string | null {
  if (!articleNumber || !instanceUrl) return null;
  return `${instanceUrl.replace(/\/$/, "")}/kb_view.do?sysparm_article=${encodeURIComponent(articleNumber)}`;
}
