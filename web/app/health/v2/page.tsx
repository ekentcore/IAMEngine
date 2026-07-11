// Health v2 (reached via the Version 2 toggle): same checks via the shared _components/health-view,
// but denser — badge + service name share an identity cell with the detail as a note line, and the
// ok/failing counts sit in the header.
import { HealthView } from "../_components/health-view";

export const metadata = { title: "Health (v2)" };

export default function HealthV2Page() {
  return <HealthView v2 />;
}
