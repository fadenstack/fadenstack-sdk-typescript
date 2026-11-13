/**
 * The words a mark shows people, in one language: the visible label, and the title on marked HTML -- the label, a
 * space, the record's id, in every language, so readers find the id. The module owns them (sdk/52 P1); a host gives its
 * own words with any object of this shape (the chat's `UiStrings` of an earlier SDK fit it too). .NET: `ProvenanceTexts`.
 */
export interface MarkStrings {
  readonly aiGenerated: string;
  aiGeneratedTitle(record: string): string;
}

/** The label in each language the module ships, by BCP 47 tag. */
const LABELS: Readonly<Record<string, string>> = {
  en: "AI-generated",
  de: "KI-generiert",
  fr: "Généré par IA",
  es: "Generado por IA",
  "zh-Hans": "人工智能生成",
};

function markStrings(label: string): MarkStrings {
  return Object.freeze({ aiGenerated: label, aiGeneratedTitle: (record: string) => `${label} ${record}` });
}

/** The mark texts of every language the module ships, by BCP 47 tag. */
export const builtInMarkStrings: Readonly<Record<string, MarkStrings>> = Object.freeze(
  Object.fromEntries(Object.entries(LABELS).map(([tag, label]) => [tag, markStrings(label)])),
);

/**
 * The mark texts for the first of `locales` the module has: "de-AT" gets "de", "zh-CN" gets "zh-Hans" (its script),
 * "zh-TW" does not (Traditional is another script). English when none fits. Without `locales`, the host's languages,
 * best first (`navigator.languages`, where the runtime has them), as the chat's own texts choose.
 */
export function markStringsFor(locales?: string | readonly string[]): MarkStrings {
  const wanted = locales === undefined ? hostLanguages() : typeof locales === "string" ? [locales] : locales;
  const byTag = new Map(Object.entries(builtInMarkStrings).map(([tag, strings]) => [tag.toLowerCase(), strings]));
  for (const locale of wanted) {
    for (const tag of candidates(locale)) {
      const found = byTag.get(tag.toLowerCase());
      if (found) return found;
    }
  }
  return builtInMarkStrings["en"]!;
}

/** "zh-TW": zh-TW, zh-Hant-TW, zh-Hant, zh. `de_DE` is read as `de-DE`. */
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

/** The host's languages, best first, where the runtime has them (browsers, workers, Node 21+); none elsewhere. */
function hostLanguages(): readonly string[] {
  const navigator = globalThis.navigator as { languages?: readonly string[]; language?: string } | undefined;
  if (navigator?.languages?.length) return navigator.languages;
  return navigator?.language ? [navigator.language] : [];
}
