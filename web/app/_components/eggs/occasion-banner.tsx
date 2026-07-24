// Full-width occasion strip (birthday / greeting / holiday-eve), one per active occasion —
// the root layout stacks them. Server-renderable; animation is pure CSS (.egg-fall).
// Solemn occasions (Memorial Day, Yom Kippur) render muted with no animation.
import type { EggBanner } from "@/lib/eggs/occasions";

const LOOK: Record<EggBanner["kind"], { bg: string; border: string; color: string; emoji?: string }> = {
  birthday: { bg: "#fdf2f8", border: "#fbcfe8", color: "#9d174d", emoji: "🎂" },
  "holiday-eve": { bg: "#f0fdf4", border: "#bbf7d0", color: "#166534", emoji: "🎉" },
  greeting: { bg: "#eef2ff", border: "#c7d2fe", color: "#3730a3" },
};
const SOLEMN = { bg: "#f4f4f5", border: "#d4d4d8", color: "#3f3f46" };

export function OccasionBanner({ banner }: { banner: EggBanner }) {
  const look = banner.solemn ? SOLEMN : LOOK[banner.kind];
  const emoji = banner.solemn ? undefined : banner.emoji ?? LOOK[banner.kind].emoji;
  return (
    <div
      role="status"
      style={{
        display: "flex", alignItems: "center", justifyContent: "center", gap: 10, overflow: "hidden",
        padding: "0.5rem 1rem", background: look.bg, borderBottom: `1px solid ${look.border}`,
        color: look.color, fontSize: 13, fontWeight: 600, textAlign: "center",
      }}
    >
      {emoji && <span className="egg-fall" aria-hidden>{emoji}</span>}
      <span>{banner.message}</span>
      {emoji && <span className="egg-fall" aria-hidden style={{ animationDelay: "1.1s" }}>{emoji}</span>}
    </div>
  );
}
