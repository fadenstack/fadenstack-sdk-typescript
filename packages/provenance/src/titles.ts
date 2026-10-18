import { builtInStrings, stringsFor, type UiStrings } from "@fadenstack/ui";

import { RECORD_ID } from "./content.js";

/** The texts the markers write that people see: from the SDK's UI catalogues, or the host's own. */
export type MarkStrings = Pick<UiStrings, "aiGenerated" | "aiGeneratedTitle">;

/** The host's texts, or a function that returns them as the user's language changes; the browser's language by default. */
export type MarkStringsOption = MarkStrings | (() => MarkStrings);

export function resolveStrings(option: MarkStringsOption | undefined): MarkStrings {
  return typeof option === "function" ? option() : option ?? stringsFor();
}

const PLACEHOLDER = "RECORDIDPLACEHOLDER";

/** How each language's title reads around the record's id, to find the id in a title again. */
export interface TitleTemplate {
  readonly prefix: string;
  readonly suffix: string;
}

/** The title templates of `strings`: every built-in language by default. */
export function titleTemplates(strings: readonly Pick<UiStrings, "aiGeneratedTitle">[] = Object.values(builtInStrings)): TitleTemplate[] {
  return strings.map((s) => {
    const text = s.aiGeneratedTitle(PLACEHOLDER);
    const at = text.indexOf(PLACEHOLDER);
    return at < 0 ? undefined : { prefix: text.slice(0, at), suffix: text.slice(at + PLACEHOLDER.length) };
  }).filter((t): t is TitleTemplate => t !== undefined);
}

/** The record id a title of ours names, in any of the templates' languages; undefined for any other title. */
export function recordIdInTitle(title: string, templates: readonly TitleTemplate[]): string | undefined {
  const text = title.trim();
  for (const { prefix, suffix } of templates) {
    if (text.length > prefix.length + suffix.length && text.startsWith(prefix) && text.endsWith(suffix)) {
      const id = text.slice(prefix.length, text.length - suffix.length);
      if (RECORD_ID.test(id)) return id;
    }
  }
  return undefined;
}
