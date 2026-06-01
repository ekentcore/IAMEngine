// Build a link to a ServiceNow KB article. Returns null when either the
// instance URL (SN_INSTANCE_URL) or the article number is missing, so callers
// can render the link only when it will resolve.
export function kbUrl(
  instanceUrl: string | undefined | null,
  articleNumber: string | undefined | null
): string | null {
  if (!instanceUrl || !articleNumber) return null;
  const base = instanceUrl.replace(/\/+$/, "");
  return `${base}/kb_view.do?sysparm_article=${articleNumber}`;
}
