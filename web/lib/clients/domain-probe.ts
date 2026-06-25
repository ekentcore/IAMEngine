// Actively loads a client's domain to see what the live site returns — used by the AI Review to
// check whether the page that loads actually belongs to the expected company (a dead domain, a
// parked page, or a redirect to an unrelated site are all worth a human's review). Best-effort and
// read-only: a GET of the homepage, capture the final URL + <title> + description, never throw.

export type DomainProbe = {
  domain: string;
  loaded: boolean;            // got an HTML response (any 2xx/3xx-resolved page)
  status: number | null;
  finalUrl: string | null;    // where we ended up after redirects
  finalDomain: string | null; // host of finalUrl
  redirectedAway: boolean;    // final registrable domain differs from the requested one
  title: string | null;
  description: string | null; // meta description / og:site_name, whichever we find first
  error: string | null;
};

// Last two labels — a cheap "registrable domain" good enough to tell acme.com from notacme.net.
function registrable(host: string): string {
  const p = host.toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  return p.length <= 2 ? p.join(".") : p.slice(-2).join(".");
}

function decode(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ").trim();
}

function extract(html: string): { title: string | null; description: string | null } {
  const head = html.slice(0, 200_000);
  const title = head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const og = head.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1];
  const desc = head.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)?.[1]
    ?? head.match(/<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i)?.[1];
  return {
    title: title ? decode(title).slice(0, 160) : null,
    description: (og ?? desc) ? decode((og ?? desc)!).slice(0, 220) : null,
  };
}

export async function probeDomain(domain: string, timeoutMs = 6000): Promise<DomainProbe> {
  const base: DomainProbe = { domain, loaded: false, status: null, finalUrl: null, finalDomain: null, redirectedAway: false, title: null, description: null, error: null };
  // Skip anything that isn't a public hostname (no SSRF into IPs / internal names).
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(domain) || /^\d+\.\d+\.\d+\.\d+$/.test(domain)) {
    return { ...base, error: "not a public domain" };
  }
  for (const scheme of ["https", "http"]) {
    try {
      const res = await fetch(`${scheme}://${domain}/`, {
        method: "GET",
        redirect: "follow",
        headers: { "User-Agent": "iam-engine-review/1.0", Accept: "text/html,*/*" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const finalUrl = res.url || `${scheme}://${domain}/`;
      const finalDomain = (() => { try { return new URL(finalUrl).host; } catch { return null; } })();
      const html = (res.headers.get("content-type") ?? "").includes("html") ? await res.text().catch(() => "") : "";
      const { title, description } = extract(html);
      return {
        ...base,
        loaded: res.ok,
        status: res.status,
        finalUrl,
        finalDomain,
        redirectedAway: Boolean(finalDomain && registrable(finalDomain) !== registrable(domain)),
        title,
        description,
        error: res.ok ? null : `HTTP ${res.status}`,
      };
    } catch (e) {
      base.error = e instanceof Error ? (e.name === "TimeoutError" ? "timed out" : e.message) : "fetch failed";
      // https failed — try http next; if that also fails we return base with the last error.
    }
  }
  return base;
}

// Run probes with a bounded concurrency pool so a roster sweep doesn't open hundreds of sockets.
export async function probeDomains(domains: string[], concurrency = 12, timeoutMs = 6000): Promise<Map<string, DomainProbe>> {
  const out = new Map<string, DomainProbe>();
  const unique = [...new Set(domains.filter(Boolean))];
  let i = 0;
  async function worker() {
    while (i < unique.length) {
      const d = unique[i++];
      out.set(d, await probeDomain(d, timeoutMs));
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker));
  return out;
}
