import { RECORD_ID } from "./content.js";
import { builtInMarkStrings, markStringsFor, type MarkStrings } from "./strings.js";

export type { MarkStrings } from "./strings.js";

/** The host's texts, or a function that returns them as the user's language changes; the runtime's language by default. */
export type MarkStringsOption = MarkStrings | (() => MarkStrings);

export function resolveStrings(option: MarkStringsOption | undefined): MarkStrings {
  return typeof option === "function" ? option() : option ?? markStringsFor();
}

const PLACEHOLDER = "RECORDIDPLACEHOLDER";

/** How each language's title reads around the record's id, to find the id in a title again. */
export interface TitleTemplate {
  readonly prefix: string;
  readonly suffix: string;
}

/** The title templates of `strings`: every built-in language by default. */
export function titleTemplates(strings: readonly Pick<MarkStrings, "aiGeneratedTitle">[] = Object.values(builtInMarkStrings)): TitleTemplate[] {
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
