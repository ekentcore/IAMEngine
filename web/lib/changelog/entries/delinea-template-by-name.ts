import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "delinea-template-by-name",
  date: "2026-07-21",
  time: "08:45",
  title: "Guided API setup creates secrets on the Automation - API template by name",
  items: [
    "Creating a secret in Delinea (guided Mimecast/Spanning/Proofpoint setup, Create in Delinea) previously required a per-instance template id in env for every secret name - without one the create refused, and a wrong id landed the secret on the wrong template",
    "Secrets that live on a stock template the app knows by name (Automation - API for mimecast, spanning, proofpoint, adobe, slack, google-admin) now resolve the template id live from Secret Server by that name - no template env needed; an explicit DELINEA_TEMPLATE_MAP id still wins as an override",
    "Field slugs are now matched case-insensitively against the template, so client id lands in clientID and the secret in ClientSecret exactly as the stock template spells them",
  ],
};
