import type { ChatStreamer } from "@fadenstack/client";
import type { SkillFile, SkillIssue, SkillIssueCode, SkillOrigin, SkillZipFile } from "@fadenstack/agents";

import type { UiStrings } from "../strings.js";

// The skill editor's view models (sdk/51 F04, the third slice). .NET: Fadenstack.UI.Skills. They are built on `SkillWorkshop`
// (`@fadenstack/agents`, which `@fadenstack/skills` implements), so the UI package never imports a module. There is no dispatcher
// here (no UI thread); state changes and `notify()` happen where the answers arrive. The texts come from a function, so a language
// change is `retext()` away.

/**
 * What the editor needs from the app that a view model cannot do itself: choose a file to import, hand over the exported zip, and
 * choose a file to add to a skill. The skin implements it with the browser's file picker and a download; a host without any
 * answers undefined or false. A browser has no folders, so a zip is the only way in.
 */
export interface SkillFileHost {
  /** The zip the person chose to import; undefined when they cancelled. */
  pickImport(signal?: AbortSignal): Promise<SkillZipFile | undefined>;
  /** Hands the exported zip to the person (a download); false when they cancelled or it could not be done. */
  saveExport(suggestedFileName: string, zip: Uint8Array): Promise<boolean>;
  /** A file the person chose to add to a skill (its name and content); undefined when they cancelled. */
  pickResource(signal?: AbortSignal): Promise<SkillFile | undefined>;
}

/** The model the editor's "ask once" and the draft use: the chat's own client. One call; no tool is run by anything here. */
export type SkillModel = ChatStreamer;

/** The texts, asked for on every use so that a language change shows at once. */
export type StringsSource = () => UiStrings;

/** One check's finding, in words, for the list under the editor. */
export interface SkillIssueView {
  readonly issue: SkillIssue;
  readonly text: string;
  /** An error stops the save; a warning only says. */
  readonly isError: boolean;
  /** The field or file it is about (`name`, `description`, `instructions`, a path), for a skin that marks the field. */
  readonly subject: string | undefined;
}

/** What a check found, in words: a rule broken, with the field or file, the limit, the size and the detail that go with it. */
export function skillIssueText(strings: UiStrings, code: SkillIssueCode, subject: string, limit: number, actual: number, detail: string): string {
  const template = strings.skillIssue[code] ?? code;
  const values = [subject, String(limit), String(actual), detail];
  return template.replace(/\{([0-3])\}/g, (_, index: string) => values[Number(index)]!);
}

export function skillIssueView(issue: SkillIssue, strings: UiStrings): SkillIssueView {
  return {
    issue,
    text: skillIssueText(strings, issue.code, issue.subject ?? "", issue.limit, issue.actual, issue.detail ?? ""),
    isError: issue.isError,
    subject: issue.subject,
  };
}

/** Where a skill comes from, in words. */
export function skillOriginLabel(strings: UiStrings, origin: SkillOrigin): string {
  return origin === "bundled" ? strings.skillOriginBundled : origin === "own" ? strings.skillOriginOwn : strings.skillOriginOrganisation;
}

/** How the pre-selection came to pick a skill: `explicit`, `always` or `trigger`. */
export function skillMatchLabel(strings: UiStrings, matchedBy: string): string {
  return matchedBy === "explicit" ? strings.skillMatchExplicit : matchedBy === "always" ? strings.skillMatchAlways
    : matchedBy === "trigger" ? strings.skillMatchTrigger : matchedBy;
}

/** The name of an activation: `auto`, `always` or `manual`. */
export function skillActivationLabel(strings: UiStrings, activation: string): string {
  return activation === "always" ? strings.skillActivationAlways : activation === "manual" ? strings.skillActivationManual : strings.skillActivationAuto;
}
