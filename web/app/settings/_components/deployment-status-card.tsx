// Bottom-of-Settings note: is this site running the latest push? Shows the commit the running server
// was built from and the latest commit on GitHub main, with a verdict. Server component (display
// only) — the data comes from loadDeploymentStatus(); timestamps render in the viewer's zone via
// LocalDateTime. Reloading the page re-checks (the loader is cached ~5 min against the GitHub rate limit).
import { LocalDateTime } from "../../_components/local-datetime";
import { verdictLabel } from "@/lib/deploy/deployment-status";
import type { DeploymentStatusLoad } from "../_lib/loader";

function commitUrl(repo: string, sha: string | null): string | null {
  return sha ? `https://github.com/${repo}/commit/${sha}` : null;
}

function Sha({ repo, sha, short }: { repo: string; sha: string | null; short: string | null }) {
  if (!sha) return <span className="muted">unknown</span>;
  const url = commitUrl(repo, sha);
  return (
    <a href={url ?? "#"} target="_blank" rel="noreferrer" title={sha}>
      <code style={{ fontSize: 12 }}>{short ?? sha.slice(0, 7)}</code>
    </a>
  );
}

const VERDICT_COLOR = {
  "up-to-date": "var(--ok-fg)",
  behind: "var(--warn-fg)",
  unknown: "var(--muted)",
} as const;

const VERDICT_MARK = { "up-to-date": "✓", behind: "⚠", unknown: "·" } as const;

export function DeploymentStatusCard({ status }: { status: DeploymentStatusLoad }) {
  const { running, latest, behindBy, verdict, repo, branch, checkedAt, error } = status;
  return (
    <section style={{ marginTop: "2.5rem", paddingTop: "1rem", borderTop: "1px solid var(--border)" }}>
      <h2 style={{ marginBottom: "0.25rem" }}>Deployment status</h2>
      <p className="note" style={{ marginTop: 0 }}>
        Whether this site is running the latest push to <code style={{ fontSize: 12 }}>{repo}</code>@{branch}.
      </p>

      <div style={{ color: VERDICT_COLOR[verdict], fontWeight: 600, margin: "0.5rem 0" }}>
        {VERDICT_MARK[verdict]} {verdictLabel(verdict, behindBy)}
      </div>

      <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.25rem 1rem", margin: 0, fontSize: 13 }}>
        <dt className="muted">Running commit</dt>
        <dd style={{ margin: 0 }}>
          <Sha repo={repo} sha={running.sha} short={running.shortSha} />
          {running.commitDate && <> · <LocalDateTime iso={running.commitDate} /></>}
          {running.source === "unknown" && (
            <span className="note" style={{ color: "var(--muted)" }}> — this build didn't record its commit (older image); redeploy to enable this check</span>
          )}
          {running.builtAt && <span className="note" style={{ color: "var(--muted)" }}> · built <LocalDateTime iso={running.builtAt} /></span>}
        </dd>

        <dt className="muted">GitHub {branch}</dt>
        <dd style={{ margin: 0 }}>
          {latest ? (
            <>
              <Sha repo={repo} sha={latest.sha} short={latest.shortSha} />
              {latest.date && <> · <LocalDateTime iso={latest.date} /></>}
              {latest.message && <span className="muted"> · {latest.message}</span>}
            </>
          ) : (
            <span className="muted">couldn't reach GitHub</span>
          )}
        </dd>
      </dl>

      <p className="note" style={{ color: "var(--muted)", marginTop: "0.5rem", fontSize: 12 }}>
        Checked <LocalDateTime iso={checkedAt} />{error ? ` · ${error}` : ""}. Reload to re-check.
      </p>
    </section>
  );
}
