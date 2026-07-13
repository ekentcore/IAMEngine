// Build change log (Global Admin and above). Entries live in lib/changelog/entries.ts — one is
// appended whenever a feature ships. Each entry can be shared to the configured chat channels.
import { ChangelogView } from "./_components/changelog-view";
import { loadChangelogPage } from "./_lib/loader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Change log" };

export default async function ChangelogPage() {
  const { entries } = await loadChangelogPage();
  return (
    <main>
      <h1>Change log</h1>
      <p className="note">What was built, newest first. Send any update to the team chats configured in Settings — with your own comment on top.</p>
      <ChangelogView entries={entries} />
    </main>
  );
}
