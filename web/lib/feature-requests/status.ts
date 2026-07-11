// Feature-request lifecycle: the DB stores the short key; the UI shows the human label + a badge
// color. Anyone can see a request's status on /feature-requests; admins (settings.manage) set it.
export const FR_STATUSES = ["new", "planned", "building", "done", "declined"] as const;
export type FeatureRequestStatus = (typeof FR_STATUSES)[number];

export const FR_STATUS_META: Record<FeatureRequestStatus, { label: string; fg: string; bg: string }> = {
  new: { label: "New", fg: "var(--muted, #6b7280)", bg: "var(--bg-soft, #f3f4f6)" },
  planned: { label: "Planned", fg: "var(--info-fg, #1d4ed8)", bg: "var(--info-bg, #eff6ff)" },
  building: { label: "Being scripted", fg: "#92400e", bg: "#fffbeb" },
  done: { label: "Implemented", fg: "var(--ok-fg, #15803d)", bg: "var(--ok-bg, #f0fdf4)" },
  declined: { label: "Rejected", fg: "var(--err-fg, #b91c1c)", bg: "var(--err-bg, #fef2f2)" },
};

export function frStatusMeta(status: string) {
  return FR_STATUS_META[(status as FeatureRequestStatus)] ?? FR_STATUS_META.new;
}
