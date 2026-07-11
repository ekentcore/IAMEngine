// Shared feature-request status pill (New / Being scripted / Planned / Implemented / Rejected).
import { frStatusMeta } from "@/lib/feature-requests/status";

export function FeatureStatusBadge({ status }: { status: string }) {
  const m = frStatusMeta(status);
  return (
    <span className="badge" style={{ color: m.fg, background: m.bg, borderColor: "transparent", whiteSpace: "nowrap" }}>
      {m.label}
    </span>
  );
}
