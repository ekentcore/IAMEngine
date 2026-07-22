import type { SecretSearchRecord } from "./delinea-search";
import { rankDelineaSuggestions, type RankedSuggestion } from "./delinea-suggestions";
import { defaultTemplateName } from "./delinea-templates";

export type RankedSuggestionWithNote = RankedSuggestion & { note?: string };

export type BuildSuggestionsDeps = {
  listSecrets: (folderId: number) => Promise<SecretSearchRecord[]>;
  fetchNote: (secretId: number) => Promise<string | undefined>;
};
export type BuildSuggestionsArgs = {
  clientFolderId: string | null;
  secretName: string;
  subfolders: string[];
  noteTopN: number;
};

export async function buildSuggestions(
  deps: BuildSuggestionsDeps,
  args: BuildSuggestionsArgs
): Promise<{ folderResolved: boolean; suggestions: RankedSuggestionWithNote[] }> {
  if (!args.clientFolderId) return { folderResolved: false, suggestions: [] };
  const candidates = await deps.listSecrets(Number(args.clientFolderId));
  const ranked = rankDelineaSuggestions(candidates, {
    secretName: args.secretName,
    templateName: defaultTemplateName(args.secretName),
    subfolders: args.subfolders,
  });
  const withNotes: RankedSuggestionWithNote[] = [];
  for (let i = 0; i < ranked.length; i++) {
    let note: string | undefined;
    if (i < args.noteTopN) {
      try { note = await deps.fetchNote(ranked[i].secretId); } catch { note = undefined; }
    }
    withNotes.push({ ...ranked[i], note });
  }
  return { folderResolved: true, suggestions: withNotes };
}
