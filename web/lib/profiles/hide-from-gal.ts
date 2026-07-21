// Client-safe (no DB, no runner) resolution of the offboard "hide from GAL" policy.
// Mirrors the runner's Test-CtgHideFromGal truthiness so the planner and the executor
// agree on what { value: false } means. Clients spell the key both `hideFromGal` and
// `hideFromGAL` (see profiles/coretelligent.json), so every read is case-insensitive.

function readHideFromGal(config: unknown): unknown {
  if (!config || typeof config !== "object") return undefined;
  const rec = config as Record<string, unknown>;
  if ("hideFromGal" in rec) return rec.hideFromGal;
  if ("hideFromGAL" in rec) return rec.hideFromGAL;
  return undefined;
}

function isExplicitNo(value: unknown): boolean {
  if (value === false) return true;
  if (typeof value === "string") return /^(?:false|no|off|0)$/i.test(value.trim());
  if (value && typeof value === "object" && "value" in (value as Record<string, unknown>)) {
    const inner = (value as Record<string, unknown>).value;
    if (inner === false) return true;
    if (typeof inner === "string") return /^(?:false|no|off|0)$/i.test(inner.trim());
  }
  return false;
}

// True only when the client explicitly said "do not hide". Absence = default-on = not opted out.
export function hideFromGalOptedOut(config: unknown): boolean {
  return isExplicitNo(readHideFromGal(config));
}

// True when the AD lane carries a concrete attribute to write (the only shape the AD module acts on).
export function adLaneHidesViaAttribute(config: unknown): boolean {
  const v = readHideFromGal(config);
  if (!v || typeof v !== "object") return false;
  const attr = (v as Record<string, unknown>).attribute;
  return typeof attr === "string" && attr.trim().length > 0;
}
