import type { UiStrings } from "./strings.js";

/**
 * A time a person allows, or the time left, in the panel's words: "15 min", "2 h", "1 h 30 min" -- never "120 min". A
 * started minute counts whole (59 s is "1 min"). .NET: `UiStrings.Period`.
 */
export function period(strings: UiStrings, milliseconds: number): string {
  const minutes = Math.max(0, Math.ceil(milliseconds / 60_000));
  if (minutes < 60) return strings.durationMinutes(minutes);
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? strings.durationHours(hours) : strings.durationHoursMinutes(hours, minutes % 60);
}

/** What a grant lets the agent do without asking, by the classes it covers: the card's line. */
export function grantMay(strings: UiStrings, classes: readonly string[]): string {
  const write = classes.includes("write");
  return strings.grantMay[classes.includes("read") && write ? "read_write" : write ? "write" : "read"];
}

/** The level the server records of each call under Bypass: `decisions`, `results`, else `calls`. */
export function evidenceLevel(evidence: string | null | undefined): "decisions" | "calls" | "results" {
  return evidence === "decisions" ? "decisions" : evidence === "results" ? "results" : "calls";
}

/** A place as Settings and a summary list it: a file's name, else as given. */
export function shortPlace(identifier: string): string {
  const name = identifier.replace(/[/\\]+$/, "").split(/[/\\]/).pop();
  return name ? name : identifier;
}
