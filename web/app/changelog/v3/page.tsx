// Change log v3 (the "Version 3" slider serves this at /changelog): same data via the shared
// _lib/loader.ts. v3 chrome — clean header (no "(v2)" label); ChangelogView renders directly.
import { ChangelogView } from "../_components/changelog-view";
import { loadChangelogPage } from "../_lib/loader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Change log" };

export default async function ChangelogV3Page() {
  const { entries } = await loadChangelogPage();
  return (
    <main>
      <h1>Change log</h1>
      <p className="note">What was built, newest first. Send any update to the team chats configured in Settings — with your own comment on top.</p>
      <ChangelogView entries={entries} />
    </main>
  );
}
