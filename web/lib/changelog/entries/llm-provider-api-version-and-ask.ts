import type { ChangelogEntry } from "../format";

export const entry: ChangelogEntry = {
  id: "llm-provider-api-version-and-ask",
  date: "2026-07-13",
  time: "22:15",
  title: "LLM providers: an API version field for Azure, ask-it-a-question testing, and a reveal eye on the key",
  items: [
    "Settings - LLM providers now has an API version field. Azure's classic /openai/deployments/... endpoint REQUIRES ?api-version=, and there was no way to set one, so those endpoints could not be registered at all - the only Azure preset worked by pointing at the newer /openai/v1 path that defaults the version for you",
    "The version is sent by the fix lane's real calls too, not just the connection test, so a provider that tests green actually works when the lane uses it",
    "A new 'Azure AI (deployment)' preset fills in the classic deployment URL shape and a working api-version; the existing 'Azure AI' preset is unchanged and still needs no version",
    "Test now has an 'Ask...' box: type any question, send it to that provider, and read the model's actual reply. The plain Test button still sends the cheap 1-token ping. Useful for confirming a provider is really wired to the model you think it is",
    "The API key box has a reveal eye, so you can check what you pasted before saving. It only ever reveals what you just typed - the stored key is still write-only and never leaves the server",
    "The test endpoint still refuses to take a base URL or key from the browser: it always uses the stored provider, so it cannot be used to point an existing key at someone else's host",
  ],
};
