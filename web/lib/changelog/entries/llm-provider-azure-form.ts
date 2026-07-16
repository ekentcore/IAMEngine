import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "llm-provider-azure-form",
  date: "2026-07-13",
  time: "22:45",
  title: "Azure AI providers are set up with Azure's own fields, and switching model no longer re-asks for the key",
  items: [
    "Picking the Azure AI preset now asks for what Azure actually gives you - resource endpoint, deployment, API version, key - instead of making you hand-assemble a base URL with the deployment buried in the path. That hand-assembly is how the previous provider ended up 404ing",
    "The base URL is derived and shown live ('Calls: ...') so you can see exactly what will be requested before saving",
    "Change the model by changing the Deployment field - in Azure the deployment is what selects the model. Editing an existing Azure provider re-opens it in the same three fields rather than as a raw URL",
    "Switching deployment no longer forces you to re-type the API key. The re-enter-the-key rule now triggers on a change of HOST rather than any URL change - a path-only edit keeps the key on the same server, so it cannot leak it. Repointing at a different host (or changing the adapter) still demands the key, and an unparseable URL still fails closed",
    "Added a Custom preset for any other OpenAI-compatible endpoint, and an 'Advanced - edit the raw URL' escape hatch on the Azure form",
  ],
};
