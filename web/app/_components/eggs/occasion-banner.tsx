// Full-width occasion strip (birthday / holiday-eve), mounted by the root layout next to the other
// global banners. Server-renderable — the animation is pure CSS (.egg-fall in globals.css).
import type { EggBanner } from "@/lib/eggs/occasions";

const LOOK: Record<EggBanner["kind"], { bg: string; border: string; color: string; emoji: string }> = {
  birthday: { bg: "#fdf2f8", border: "#fbcfe8", color: "#9d174d", emoji: "🎂" },
  "holiday-eve": { bg: "#f0fdf4", border: "#bbf7d0", color: "#166534", emoji: "🎉" },
};

export function OccasionBanner({ banner }: { banner: EggBanner }) {
  const look = LOOK[banner.kind];
  return (
    <div
      role="status"
      style={{
        display: "flex", alignItems: "center", justifyContent: "center", gap: 10, overflow: "hidden",
        padding: "0.5rem 1rem", background: look.bg, borderBottom: `1px solid ${look.border}`,
        color: look.color, fontSize: 13, fontWeight: 600, textAlign: "center",
      }}
    >
      <span className="egg-fall" aria-hidden>{look.emoji}</span>
      <span>{banner.message}</span>
      <span className="egg-fall" aria-hidden style={{ animationDelay: "1.1s" }}>{look.emoji}</span>
    </div>
  );
}
