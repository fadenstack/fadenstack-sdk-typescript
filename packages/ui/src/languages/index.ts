import { englishStrings, type UiStrings } from "../strings.js";
import { germanStrings } from "./de.js";
import { spanishStrings } from "./es.js";
import { frenchStrings } from "./fr.js";
import { chineseSimplifiedStrings } from "./zh-hans.js";

export { chineseSimplifiedStrings, frenchStrings, germanStrings, spanishStrings };

/** The languages the SDK ships, by BCP 47 tag. A host adds its own: `{ ...builtInStrings, it: italianStrings }`. */
export const builtInStrings: Readonly<Record<string, UiStrings>> = Object.freeze({
  en: englishStrings,
  de: germanStrings,
  fr: frenchStrings,
  es: spanishStrings,
  "zh-Hans": chineseSimplifiedStrings,
});

/**
 * The texts for the first of `locales` there is a translation for, from the most specific tag to the language
 * alone: "de-AT" gets "de", "zh-CN" gets "zh-Hans" (its script), "zh-TW" does not (Traditional is another script).
 * English when none fits. Without `locales`, the browser's languages, best first. `de_DE` is read as `de-DE`.
 */
export function stringsFor(
  locales?: string | readonly string[],
  translations: Readonly<Record<string, UiStrings>> = builtInStrings,
): UiStrings {
  const wanted = locales === undefined ? browserLanguages() : typeof locales === "string" ? [locales] : locales;
  const byTag = new Map(Object.entries(translations).map(([tag, strings]) => [tag.toLowerCase(), strings]));
  for (const locale of wanted) {
    for (const tag of candidates(locale)) {
      const found = byTag.get(tag.toLowerCase());
      if (found) return found;
    }
  }
  return byTag.get("en") ?? englishStrings;
}

/** "zh-TW": zh-TW, zh-Hant-TW, zh-Hant, zh. */
function candidates(locale: string): string[] {
  const tag = locale.trim().replace(/_/g, "-");
  if (!tag) return [];
  try {
    const parsed = new Intl.Locale(tag);
    const full = parsed.maximize();
    const tags = [tag, full.baseName];
    if (full.script) tags.push(`${full.language}-${full.script}`);
    tags.push(parsed.language);
    return tags;
  } catch {
    return [tag, tag.split("-")[0]!];
  }
}

function browserLanguages(): readonly string[] {
  const navigator = globalThis.navigator as { languages?: readonly string[]; language?: string } | undefined;
  if (navigator?.languages?.length) return navigator.languages;
  return navigator?.language ? [navigator.language] : [];
}
