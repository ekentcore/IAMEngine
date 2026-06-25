// Clients v2 — AI Review. Heuristic findings render immediately on load; "Run AI review" layers on
// the LLM's fuzzy findings (domain-doesn't-match-company, anything weird). No nav link — reached from
// the /clients/v2 header.
import Link from "next/link";
import { db } from "@/lib/db";
import { makeClientRepository } from "@/lib/clients/repository";
import { currentClientScope } from "@/lib/auth/client-scope";
import { heuristicFindings } from "@/lib/clients/review";
import { azureConfigFromEnv, azureConfigured } from "@/lib/generator/llm";
import { AiReviewView } from "./_components/ai-review-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Clients — AI Review" };

export default async function ClientsReviewPage() {
  const scope = await currentClientScope(db);
  const clients = await makeClientRepository(db).listClients(scope);
  const initial = heuristicFindings(clients);

  return (
    <main>
      <div className="row-between">
        <div>
          <h1>AI Review <span className="note">— client data quality</span></h1>
          <p className="note">{clients.length} clients scanned · {initial.length} heuristic issue{initial.length === 1 ? "" : "s"} · run the AI pass to catch subtle ones</p>
        </div>
        <Link href="/clients/v2" className="note" style={{ alignSelf: "flex-start" }}>← back to Clients v2</Link>
      </div>

      <AiReviewView initial={initial} clientCount={clients.length} aiAvailable={azureConfigured(azureConfigFromEnv())} />
    </main>
  );
}
