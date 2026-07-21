import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "guided-setup-fuller-instructions",
  date: "2026-07-21",
  time: "09:15",
  title: "Guided API setup carries the full vendor instructions",
  items: [
    "The Setup Mimecast API modal now walks the whole registration: Integrations → API and Platform Integrations → Add API Application, the iam-engine naming/category/point-of-contact conventions, the Basic Administrator role, the three required products (Account / Domain / User & Group Management - the app_forbidden trap), then Generate under Manage API 2.0 credentials",
    "Every guided setup modal (Mimecast / Spanning / Proofpoint) links its full in-app guide (/help/mimecast, /help/spanning, /help/proofpoint) next to Open console",
  ],
};
