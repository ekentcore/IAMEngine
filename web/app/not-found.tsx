// The app-wide 404 — which is itself an easter egg (the "not-found-nope" catalog entry).
// All the fun lives in the client component so the demo on /easter-eggs can replay it.
import { NopeShow } from "./_components/eggs/nope-404";

export default function NotFound() {
  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "1rem 1.5rem" }}>
      <NopeShow />
    </main>
  );
}
