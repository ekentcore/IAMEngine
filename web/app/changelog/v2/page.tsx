// Change log v2: same data via the shared _lib/loader.ts.
import { ChangelogView } from "../_components/changelog-view";
import { loadChangelogPage } from "../_lib/loader";

export const dynamic = "force-dynamic";
export const metadata = { title: "Change log (v2)" };

export default async function ChangelogV2Page() {
  const { entries } = await loadChangelogPage();
  return (
    <main>
      <h1>Change log <span className="note">(v2)</span></h1>
      <p className="note">What was built, newest first. Send any update to the team chats configured in Settings — with your own comment on top.</p>
      <ChangelogView entries={entries} />
    </main>
  );
}
