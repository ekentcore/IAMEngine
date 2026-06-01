// Render a client's current systems back into a ServiceNow-pasteable KB runbook, in both
// HTML (mirrors the corpus body_html: TOC + <h2> per system) and Markdown. The reverse of
// lib/generator/parse.
import type { ClientDetail } from "./types";

const SECTION_TITLE: Record<string, string> = {
  servicenow: "ServiceNow", m365: "Microsoft 365", entra: "Microsoft Entra",
  exchange: "Exchange", "active-directory": "Active Directory", "directory-sync": "AD Sync",
  "google-workspace": "Google Workspace", mimecast: "Mimecast", proofpoint: "Proofpoint",
  knowbe4: "KnowBe4", adobe: "Adobe", spanning: "Spanning", sharepoint: "SharePoint",
  zoom: "Zoom", slack: "Slack", egnyte: "Egnyte", mdm: "MDM", dropbox: "Dropbox",
  perimeter81: "Perimeter 81", teams: "Teams Phone", avd: "Azure Virtual Desktop",
  "1password": "1Password", notion: "Notion", tableau: "Tableau", printix: "Printix",
  hardware: "Hardware", workstation: "Workstation", "welcome-letter": "Welcome Letter",
  "first-day-call": "First-Day Call", "case-resolution": "Case Resolution",
};

const title = (key: string) => SECTION_TITLE[key] ?? key;
const laneText = (when: string) =>
  when === "always" ? "Always" : when === "on_request" ? "On request" : "Not applicable";

// Build per-system step lines for the chosen action, skipping "never" lanes.
type Section = { key: string; name: string; mode: string; onboard: string; offboard: string; config: unknown };

function sections(c: ClientDetail, action: "onboard" | "offboard"): Section[] {
  return c.systems
    .filter((s) => (action === "onboard" ? s.onboardWhen : s.offboardWhen) !== "never")
    .map((s) => ({
      key: s.systemKey, name: title(s.systemKey), mode: s.mode,
      onboard: s.onboardWhen, offboard: s.offboardWhen,
      config: (s as { config?: unknown }).config,
    }));
}

function configLines(config: unknown, action: "onboard" | "offboard"): string[] {
  const c = (config as { onboard?: Record<string, unknown>; offboard?: Record<string, unknown> } | null) ?? {};
  const block = c[action];
  if (!block || typeof block !== "object") return [];
  return Object.entries(block).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
}

export function renderMarkdown(c: ClientDetail, action: "onboard" | "offboard"): string {
  const secs = sections(c, action);
  const heading = action === "onboard" ? "New User Onboarding Guide" : "User Offboarding Guide";
  const lines = [`# ${heading} - ${c.name}`, "", `_Backbone: ${c.backbone ?? "not modeled"}_`, "", "## Table of Contents"];
  secs.forEach((s) => lines.push(`- ${s.name}`));
  lines.push("");
  for (const s of secs) {
    const when = action === "onboard" ? s.onboard : s.offboard;
    lines.push(`## ${s.name}`, `_Mode: ${s.mode} · ${laneText(when)}_`, "");
    const cfg = configLines(s.config, action);
    if (cfg.length) cfg.forEach((l) => lines.push(`- ${l}`));
    else lines.push(`- Perform ${s.name} ${action} steps.`);
    lines.push("");
  }
  return lines.join("\n");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderHtml(c: ClientDetail, action: "onboard" | "offboard"): string {
  const secs = sections(c, action);
  const heading = action === "onboard" ? "New User Onboarding Guide" : "User Offboarding Guide";
  const parts = [
    `<h1>${esc(heading)} - ${esc(c.name)}</h1>`,
    `<p><em>Backbone: ${esc(c.backbone ?? "not modeled")}</em></p>`,
    `<h2>Table of Contents</h2>`,
    `<ul>${secs.map((s) => `<li>${esc(s.name)}</li>`).join("")}</ul>`,
  ];
  for (const s of secs) {
    const when = action === "onboard" ? s.onboard : s.offboard;
    parts.push(`<h2>${esc(s.name)}</h2>`);
    parts.push(`<p><em>Mode: ${esc(s.mode)} &middot; ${esc(laneText(when))}</em></p>`);
    const cfg = configLines(s.config, action);
    parts.push(`<ul>${(cfg.length ? cfg : [`Perform ${s.name} ${action} steps.`]).map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`);
  }
  return parts.join("\n");
}

export function renderKb(c: ClientDetail) {
  return {
    onboard: { html: renderHtml(c, "onboard"), markdown: renderMarkdown(c, "onboard") },
    offboard: { html: renderHtml(c, "offboard"), markdown: renderMarkdown(c, "offboard") },
  };
}
