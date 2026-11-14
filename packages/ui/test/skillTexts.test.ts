import { describe, expect, it } from "vitest";
import { SkillIssueCode, SkillLimits, SkillOrigin } from "@fadenstack/agents";
import {
  builtInStrings,
  englishStrings,
  frenchStrings,
  skillActivationLabel,
  skillIssueText,
  skillMatchLabel,
  skillOriginLabel,
  withStrings,
  type UiStrings,
} from "@fadenstack/ui";

// The skill editor's texts exist in all five languages, with the same places filled, and say what the checks mean.
// (.NET: SkillTextsTests.cs.)

const LANGUAGES = ["en", "de", "fr", "es", "zh-Hans"] as const;
const CODES = Object.values(SkillIssueCode);
const OTHERS = LANGUAGES.filter((l) => l !== "en");

const placeholders = (template: string): string[] => [...new Set([...template.matchAll(/\{(\d)\}/g)].map((m) => m[1]!))].sort();

describe("the skill editor's texts", () => {
  it("are offered in the five built-in languages", () => {
    expect(Object.keys(builtInStrings).sort()).toEqual([...LANGUAGES].sort());
  });

  describe.each(LANGUAGES)("in %s", (language) => {
    const strings = builtInStrings[language]!;

    it("has every skill text that English has, with the same kind of value", () => {
      const keys = Object.keys(englishStrings).filter((k) => k.startsWith("skill"));
      expect(keys.length).toBeGreaterThan(80);
      for (const key of keys) {
        const english = (englishStrings as unknown as Record<string, unknown>)[key];
        const value = (strings as unknown as Record<string, unknown>)[key];
        expect(value, `${language}: ${key} is missing`).toBeDefined();
        expect(typeof value, `${language}: ${key} has another kind of value`).toBe(typeof english);
        if (typeof value === "string") expect(value.length, `${language}: ${key} is empty`).toBeGreaterThan(0);
        if (typeof value === "function" && key === "skillTokens") {
          // the one text that takes numbers: the size and the limit, written the language's way
          const said = (value as (tokens: number, limit: number) => string)(1234, 5000);
          expect(said, `${language}: ${key} leaves out the size`).toContain(new Intl.NumberFormat(language).format(1234));
          expect(said, `${language}: ${key} leaves out the limit`).toContain(new Intl.NumberFormat(language).format(5000));
        } else if (typeof value === "function") {
          const said = (value as (name: string) => string)("some-skill");
          expect(said.length, `${language}: ${key} says nothing`).toBeGreaterThan(0);
          expect(said, `${language}: ${key} leaves out the name`).toContain("some-skill");
        }
      }
    });

    it("says every check in words, with its numbers and detail filled in", () => {
      for (const code of CODES) {
        const template = strings.skillIssue[code];
        const text = skillIssueText(strings, code, "references/a.md", 1234, 5678, "DETAIL");

        expect(template, `${language}: no text for ${code}`).toBeTypeOf("string");
        expect(template.length, `${language}: no text for ${code}`).toBeGreaterThan(0);
        expect(text).not.toContain("{");
        expect(text).not.toContain("}");
        expect(text, `${language}: ${code} shows its name`).not.toBe(code);
        expect(text).not.toContain("undefined");
      }
    });

    it("uses the same places as English for every check", () => {
      for (const code of CODES) {
        expect(placeholders(strings.skillIssue[code]), `${language}: ${code}`).toEqual(placeholders(englishStrings.skillIssue[code]));
      }
    });

    it("names the limits the validator enforces", () => {
      const name = skillIssueText(strings, SkillIssueCode.NameTooLong, "name", SkillLimits.nameMax, 65, "");
      const description = skillIssueText(strings, SkillIssueCode.DescriptionTooLong, "description", SkillLimits.descriptionMax, 1025, "");

      expect(name).toContain("64");
      expect(name).toContain("65");
      expect(description).toContain("1024");
      expect(description).toContain("1025");
      expect(skillIssueText(strings, SkillIssueCode.InvisibleCharacter, "description", 0, 0, "U+200B")).toContain("U+200B");
      expect(skillIssueText(strings, SkillIssueCode.UnknownKey, "SKILL.md", 0, 0, "version")).toContain("version");
      expect(skillIssueText(strings, SkillIssueCode.FileTooLarge, "big.md", SkillLimits.fileMaxBytes, 0, "")).toContain("big.md");
    });

    it("says origins, matches and activations in different words", () => {
      const origins = [SkillOrigin.Bundled, SkillOrigin.Own, SkillOrigin.Organisation].map((o) => skillOriginLabel(strings, o));
      const matches = ["explicit", "always", "trigger"].map((m) => skillMatchLabel(strings, m));
      const activations = ["auto", "always", "manual"].map((a) => skillActivationLabel(strings, a));

      expect(new Set(origins).size).toBe(3);
      expect(new Set(matches).size).toBe(3);
      expect(new Set(activations).size).toBe(3);
      for (const text of [...origins, ...matches, ...activations]) {
        expect(text.length).toBeGreaterThan(0);
        expect(text.startsWith("skill")).toBe(false);
      }
      expect(skillMatchLabel(strings, "other")).toBe("other");
    });

    it("says the not-reviewed label and the draft promise", () => {
      expect(strings.skillNotReviewed.length).toBeGreaterThan(0);
      expect(strings.skillDraftReady.length).toBeGreaterThan(20);
      expect(strings.skillDraftReady).not.toBe(strings.skillDraftBroken);
      if (language !== "en") expect(strings.skillDraftReady).not.toBe(englishStrings.skillDraftReady);
    });
  });

  it("are not left in English in the other languages", () => {
    for (const language of OTHERS) {
      const strings = builtInStrings[language]!;
      expect(strings.skillLibraryEmpty).not.toBe(englishStrings.skillLibraryEmpty);
      expect(strings.skillDeleteBody).not.toBe(englishStrings.skillDeleteBody);
      expect(strings.skillDraftNoChat).not.toBe(englishStrings.skillDraftNoChat);
      expect(strings.skillModelNote).not.toBe(englishStrings.skillModelNote);
      expect(skillIssueText(strings, SkillIssueCode.ScriptFile, "a", 0, 0, "")).not.toBe(skillIssueText(englishStrings, SkillIssueCode.ScriptFile, "a", 0, 0, ""));
    }
  });

  describe("skillIssueText", () => {
    it("fills {0} to {3} with the subject, the limit, the size and the detail", () => {
      const strings = { ...englishStrings, skillIssue: { ...englishStrings.skillIssue, NameMissing: "[{0}|{1}|{2}|{3}] {3} {0}" } } as UiStrings;

      expect(skillIssueText(strings, SkillIssueCode.NameMissing, "the-name", 64, 70, "why")).toBe("[the-name|64|70|why] why the-name");
    });

    it("says the English texts of the checks as the editor shows them", () => {
      expect(skillIssueText(englishStrings, SkillIssueCode.NameTooLong, "name", 64, 65, "")).toBe("The name is 65 characters long; the limit is 64.");
      expect(skillIssueText(englishStrings, SkillIssueCode.InvisibleCharacter, "description", 0, 0, "U+202E")).toBe(
        "description contains an invisible character (U+202E). Remove it.",
      );
      expect(skillIssueText(englishStrings, SkillIssueCode.UnknownKey, "SKILL.md", 0, 0, "version")).toBe(
        "SKILL.md has a field the standard does not have: version. Remove it.",
      );
    });

    it("falls back to the code's name for a code no text knows", () => {
      expect(skillIssueText(englishStrings, "SomethingNew" as SkillIssueCode, "a", 0, 0, "")).toBe("SomethingNew");
    });
  });

  describe("French", () => {
    it("keeps its no-break spaces before a colon, a question mark and a guillemet", () => {
      // Known texts of UiText.fr.resx, which has the no-break space (U+00A0) before ":" and "?".
      expect(frenchStrings.aboutModel("m")).toBe("Modèle\u00a0: m");
      expect(frenchStrings.wizardServerAt("s")).toBe("Serveur\u00a0: s");
      expect(frenchStrings.approvalTitle("x")).toBe("Exécuter x\u00a0?");
      expect(frenchStrings.wizardChooseTitle("App")).toBe("Comment souhaitez-vous utiliser App\u00a0?");
      expect(frenchStrings.limitedTo("D.", "demander")).toContain("«\u00a0demander\u00a0»");
    });

    it("says the skill texts with a plain space before a colon, as UiText.fr.resx does", () => {
      expect(frenchStrings.skillIssue.SkillMdUnreadable).toBe("SKILL.md est illisible : {3}");
      expect(frenchStrings.skillIssue.NameTooLong).toBe("Le nom compte {2} caractères ; la limite est de {1}.");
    });

    it("does not break a text that has a no-break space when its places are filled in", () => {
      expect(skillIssueText(frenchStrings, SkillIssueCode.FadenYamlUnreadable, "faden.yaml", 0, 0, "ligne 3")).toBe("faden.yaml est illisible : ligne 3");
    });
  });

  describe("withStrings", () => {
    it("changes the words a host changes and leaves the others", () => {
      const strings = withStrings({ skillSave: "Keep", skillSaved: (name) => `${name} is kept.` });

      expect(strings.skillSave).toBe("Keep");
      expect(strings.skillSaved("a")).toBe("a is kept.");
      expect(strings.skillCancel).toBe(englishStrings.skillCancel);
      expect(strings.skillIssue.NameMissing).toBe(englishStrings.skillIssue.NameMissing);
    });

    it("builds on another language", () => {
      const german = builtInStrings["de"]!;

      const strings = withStrings({ skillSave: "Behalten" }, german);

      expect(strings.skillSave).toBe("Behalten");
      expect(strings.skillCancel).toBe(german.skillCancel);
      expect(skillIssueText(strings, SkillIssueCode.NameMissing, "", 0, 0, "")).toBe(german.skillIssue.NameMissing);
    });

    it("returns the base itself when there are no changes", () => {
      expect(withStrings(undefined)).toBe(englishStrings);
      expect(withStrings(undefined, frenchStrings)).toBe(frenchStrings);
    });

    // The other groups (`modes`, `approvalWhy`, ...) are completed key by key, so a host can change one word. `skillIssue` is a group
    // of the same kind but is not in that list: a host that changes one check's text loses the others (they show their code).
    it("completes the skillIssue group key by key, so a host can change one check's text", () => {
      const strings = withStrings({ skillIssue: { NameMissing: "Give it a name." } as UiStrings["skillIssue"] });

      expect(strings.skillIssue.NameMissing).toBe("Give it a name.");
      expect(strings.skillIssue.NameForm).toBe(englishStrings.skillIssue.NameForm);
    });
  });
});

describe("the texts of the skill editor's gaps", () => {
  describe.each(LANGUAGES)("in %s", (language) => {
    const strings = builtInStrings[language]!;

    it("says a broken skill, the Try heading, the draft's standing line, and the row button names, with their places filled", () => {
      expect(strings.skillBroken("REASON")).toContain("REASON");
      expect(strings.skillBroken("REASON")).not.toContain("{");
      for (const make of [strings.skillEditNamed, strings.skillViewNamed, strings.skillDeleteNamed, strings.skillExportNamed, strings.skillDuplicateNamed]) {
        expect(make("NAME")).toContain("NAME");
        expect(make("NAME")).not.toContain("{");
      }
      expect(new Set([strings.skillEditNamed("N"), strings.skillViewNamed("N"), strings.skillDeleteNamed("N"), strings.skillExportNamed("N"), strings.skillDuplicateNamed("N")]).size).toBe(5);
      expect(strings.skillTokens(1234, 5000)).not.toContain("{");
      for (const text of [strings.skillBrokenNoReason, strings.skillTestMatchesHeading, strings.skillDraftNothingSaved, strings.skillDraftOpen]) {
        expect(text.length).toBeGreaterThan(0);
        expect(text.startsWith("skill")).toBe(false);
      }
      if (language !== "en") {
        expect(strings.skillBrokenNoReason).not.toBe(englishStrings.skillBrokenNoReason);
        expect(strings.skillTestMatchesHeading).not.toBe(englishStrings.skillTestMatchesHeading);
        expect(strings.skillDraftNothingSaved).not.toBe(englishStrings.skillDraftNothingSaved);
        expect(strings.skillDraftOpen).not.toBe(englishStrings.skillDraftOpen);
        expect(strings.skillEditNamed("N")).not.toBe(englishStrings.skillEditNamed("N"));
      }
    });
  });

  it("writes the token counter's numbers the language's way", () => {
    expect(englishStrings.skillTokens(1200, 5000)).toBe("about 1,200 of 5,000 tokens");
    expect(builtInStrings["de"]!.skillTokens(1200, 5000)).toBe("etwa 1.200 von 5.000 Tokens");
  });
});