// Render a date-only intake string ("2026-06-15") in the user's locale format, matching how Date
// columns render (toLocaleDateString). Parse the components locally — new Date("2026-06-15") is
// UTC midnight and shifts a day west of UTC — and refuse to "repair" out-of-range values: JS Date
// would roll "2026-15-09" over into a plausible-looking 2027 date, so anything that isn't a real
// calendar date renders verbatim instead.
export function formatDateOnly(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return d;
  const [y, mo, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (mo < 1 || mo > 12 || day < 1 || day > 31) return d;
  const dt = new Date(y, mo - 1, day);
  if (dt.getMonth() !== mo - 1 || dt.getDate() !== day) return d; // e.g. Feb 30 would roll over
  return dt.toLocaleDateString();
}

// A full timestamp (ISO) -> "Jun 19, 2026, 3:04 PM" in the user's locale. For "when did this run".
// A bare date-only string ("2026-06-19") renders as just the date (no spurious midnight time).
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) return formatDateOnly(iso); // date-only, no time component
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
