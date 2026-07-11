// Classic health page — thin wrapper around the shared view (also served denser at /health/v2).
import { HealthView } from "./_components/health-view";

export default function HealthPage() {
  return <HealthView />;
}
