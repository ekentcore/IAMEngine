// Agents (runners) — list + enroll + enable/disable + trash. Data assembly lives in
// _lib/loader.ts, shared with /agents/v2.
import { runnerBuildId, runnerVersion } from "@/lib/runner/bundle";
import { AgentsView } from "./_components/agents-view";
import { loadAgentsPage } from "./_lib/loader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agents" };

export default async function AgentsPage() {
  const { agents, trashed, clients } = await loadAgentsPage();

  return (
    <main>
      <div className="row-between">
        <div>
          <h1>Agents</h1>
          <p className="note">
            {agents.length} runner{agents.length === 1 ? "" : "s"} · enroll one, then start it with
            {" "}<code>runner/Start-IamRunner.ps1</code> using its id.
            {" · "}<a href="/help/runner-troubleshooting">Troubleshooting guide →</a>
          </p>
        </div>
      </div>
      <AgentsView agents={agents} clients={clients} trashed={trashed} currentBuild={runnerBuildId()} currentVersion={runnerVersion()} now={Date.now()} />
    </main>
  );
}
