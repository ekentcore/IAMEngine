// LLM enrichment: read a client's runbook text and correct the load-bearing field
// (backbone) + extract light per-system config the header heuristic can't see.
import { azureChatJson, type AzureConfig } from "../../lib/generator/llm";
import { V21_SYSTEM_PROMPT, coerceV21Enrichment, type V21Enrichment } from "../../lib/generator/enrich-v21";
import type { ClientKb } from "./kb";
import type { DraftProfile } from "./build";

// v2.1 pass: pull the dropped group/attribute/persona/location signal from the runbook text.
// Returns null when the client's runbook carries no such signal (stays valid v2.0).
export async function enrichV21(cfg: AzureConfig, kb: ClientKb): Promise<V21Enrichment | null> {
  const user = `Client: ${kb.clientLeaf}
=== ONBOARDING RUNBOOK ===
${kb.onboardText || "(none)"}
=== OFFBOARDING RUNBOOK ===
${kb.offboardText || "(none)"}`;
  const raw = await azureChatJson(cfg, V21_SYSTEM_PROMPT, user, 1500);
  return raw ? coerceV21Enrichment(raw) : null;
}

const SYSTEM_PROMPT = `You are analyzing a Coretelligent IT onboarding/offboarding runbook for ONE client.
Return STRICT JSON only. Determine the identity "backbone" and extract light config.

backbone values (pick exactly one):
- "ad-synced": on-prem Active Directory synced to Entra/M365 via Azure AD Connect / Start-ADSyncSyncCycle.
- "ad-standalone": on-prem Active Directory AND a separate, unsynced M365/Entra.
- "google": Google Workspace / GSuite is the primary identity.
- "entra": cloud-only; M365/Entra is the source of truth; no on-prem AD.

Rules: only choose ad-synced/ad-standalone if the text clearly indicates an on-prem AD / domain controller / New-ADUser / AD Connect. If unsure, prefer "entra".

JSON shape:
{
  "backbone": "entra|google|ad-synced|ad-standalone",
  "backboneConfidence": "high|medium|low",
  "reason": "<one short sentence>",
  "m365Licenses": ["<license names if explicitly listed, else empty>"],
  "adOu": "<AD OU/org-unit path if mentioned, else null>",
  "groups": ["<security/distribution groups explicitly listed, else empty>"]
}`;

export type Enrichment = {
  backbone: "entra" | "google" | "ad-synced" | "ad-standalone";
  backboneConfidence: "high" | "medium" | "low";
  reason: string;
  m365Licenses: string[];
  adOu: string | null;
  groups: string[];
};

const VALID = new Set(["entra", "google", "ad-synced", "ad-standalone"]);

export async function enrichProfile(
  cfg: AzureConfig,
  kb: ClientKb
): Promise<Enrichment | null> {
  const user = `Client: ${kb.clientLeaf}
=== ONBOARDING RUNBOOK ===
${kb.onboardText || "(none)"}
=== OFFBOARDING RUNBOOK ===
${kb.offboardText || "(none)"}`;

  const raw = await azureChatJson(cfg, SYSTEM_PROMPT, user);
  if (!raw) return null;

  const backbone = String(raw.backbone ?? "");
  if (!VALID.has(backbone)) return null;

  return {
    backbone: backbone as Enrichment["backbone"],
    backboneConfidence: (["high", "medium", "low"].includes(String(raw.backboneConfidence))
      ? raw.backboneConfidence
      : "low") as Enrichment["backboneConfidence"],
    reason: String(raw.reason ?? ""),
    m365Licenses: Array.isArray(raw.m365Licenses) ? raw.m365Licenses.map(String).slice(0, 12) : [],
    adOu: raw.adOu ? String(raw.adOu) : null,
    groups: Array.isArray(raw.groups) ? raw.groups.map(String).slice(0, 20) : [],
  };
}

// Apply enrichment to a draft profile in place: fix backbone, add directorySync, and
// fold light config into m365 / active-directory systems.
export function applyEnrichment(profile: DraftProfile, e: Enrichment): void {
  profile.identity.backbone = e.backbone;
  if (e.backbone === "ad-synced" && !profile.identity.directorySync) {
    profile.identity.directorySync = { command: "Start-ADSyncSyncCycle -PolicyType Delta" };
  }
  for (const sys of profile.systems) {
    // Only enrich an existing onboard lane — never fabricate one for an offboard-only system.
    if (!sys.onboard) continue;
    const onboard = sys.onboard as Record<string, unknown>;
    if (sys.key === "m365" && e.m365Licenses.length) {
      onboard.config = { ...(onboard.config as object), licenses: e.m365Licenses };
    }
    if (sys.key === "active-directory" && (e.adOu || e.groups.length)) {
      onboard.config = { ...(onboard.config as object), ...(e.adOu ? { ou: e.adOu } : {}), ...(e.groups.length ? { groups: e.groups } : {}) };
    }
  }
}
