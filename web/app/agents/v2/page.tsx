// Agents v2 (reached via the Version 2 toggle): identical data to /agents via the shared
// _lib/loader.ts, but the view is denser — priority sits under the runner name, scope+client
// fold into the identity cell, and every per-agent action lives behind one "Actions ▾" menu
// instead of an always-visible button grid.
import { runnerBuildId, runnerVersion } from "@/lib/runner/bundle";
import { AgentsView } from "../_components/agents-view";
import { loadAgentsPage } from "../_lib/loader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agents (v2)" };

export default async function AgentsV2Page() {
  const { agents, trashed, clients } = await loadAgentsPage();

  return (
    <main>
      <div className="row-between">
        <div>
          <h1>Agents</h1>
          <p className="note">
            {agents.length} runner{agents.length === 1 ? "" : "s"} · enroll one, then start it with
            {" "}<code>runner/Start-IamRunner.ps1</code> using its id.
          </p>
        </div>
      </div>
      <AgentsView agents={agents} clients={clients} trashed={trashed} currentBuild={runnerBuildId()} currentVersion={runnerVersion()} now={Date.now()} v2 />
    </main>
  );
}
