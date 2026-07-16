import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "llm-model-aware-requests",
  date: "2026-07-14",
  time: "10:00",
  title: "The gpt-5 models work now: pick a deployment from a dropdown, and the request adapts to the model",
  items: [
    "gpt-5.4 and gpt-5.6-luna could not be used at all. Both reject 'max_tokens' (they require 'max_completion_tokens'), and gpt-5.6-luna additionally rejects 'temperature' - and the app hardcoded both. gpt-4o accepts them, which is why only it worked",
    "Requests now adapt to the model: we send our best guess, and if the model objects we do exactly what its error says and retry. What we learn is remembered, so the wasted first attempt happens at most once. A brand-new model works with no code change - the error is the authority, not a list of model names we have to keep updating",
    "Reasoning models also cannot answer a 1-token request AT ALL (the old Test button sent one): it is a hard 400, not a short reply, because they spend tokens thinking before they write. They are now given room to think even for a connectivity ping",
    "The Deployment field is a dropdown of what is really deployed on your Azure resource, read live from Azure - no more typing a name that has to match exactly. It shows the model behind each deployment and flags any that are not healthy",
    "Verified end to end against the live resource: gpt-4o, gpt-4o-mini, gpt-5.4 and gpt-5.6-luna all pass Test and answer a real question",
    "Listing deployments never sends the stored key to a host you have not proved you hold the key for - the same rule the save path enforces",
  ],
};
