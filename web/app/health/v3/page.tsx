// Health v3 (the "Version 3" slider serves this at /health): same checks via the shared
// _components/health-view — HealthView owns the whole layout, so this is the same one-liner as v2.
import { HealthView } from "../_components/health-view";

export const metadata = { title: "Health" };

export default function HealthV3Page() {
  return <HealthView v2 />;
}
