// Agents v3 (the "Version 3" slider serves this at /agents): identical data to v2 via the shared
// _lib/loader.ts, and the same denser, menu-driven presentation — priority sits under the runner
// name, scope+client fold into the identity cell, and every per-agent action lives behind one
// "Actions ▾" menu. AgentsView is interactive, so v3 just gives it a clean header and renders it.
import { runnerBuildId, runnerVersion } from "@/lib/runner/bundle";
import { AgentsView } from "../_components/agents-view";
import { loadAgentsPage } from "../_lib/loader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Agents" };

export default async function AgentsV3Page() {
  const { agents, trashed, clients, migration } = await loadAgentsPage();

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
      <AgentsView agents={agents} clients={clients} trashed={trashed} currentBuild={runnerBuildId()} currentVersion={runnerVersion()} now={Date.now()} migration={migration} v2 />
    </main>
  );
}
