import type { ApprovalPart, DiffLine, NoticeSeverity, ToolCallPart, TurnViewModel, UiStrings } from "@fadenstack/ui";

import type { IconName } from "./icons.js";

/** How the parts look, decided once for every skin: classes, icons and badges the stylesheet expects. */

/** The tool line's classes: failed, or not run (denied, stopped). */
export function toolClassName(part: ToolCallPart): string {
  const failed = part.state === "failed";
  const denied = part.state === "denied" || part.state === "cancelled";
  return `fdn-tool${failed ? " fdn-tool-failed" : ""}${denied ? " fdn-tool-denied" : ""}`;
}

/** The tool line's status icon; none while it runs (a skin shows its spinner). */
export function toolStatusIcon(part: ToolCallPart): IconName | undefined {
  if (part.isRunning) return undefined;
  if (part.state === "failed") return "warning";
  return part.state === "denied" || part.state === "cancelled" ? "close" : "check";
}

/** A badge: its text and classes. */
export interface Badge {
  text: string;
  className: string;
}

/** The tool line's badges: where the tool runs when not here, and what a tool here does when it changes something. */
export function toolBadges(part: ToolCallPart, strings: UiStrings): Badge[] {
  if (part.source !== "host") return [{ text: part.source === "gateway" ? strings.serverTool : part.source, className: "fdn-badge" }];
  if (part.toolClass !== "read") return [{ text: part.classLabel, className: `fdn-badge fdn-class-${part.toolClass}` }];
  return [];
}

export function approvalIcon(part: ApprovalPart): IconName {
  return part.isDangerous ? "warning" : "shield";
}

export function noticeIcon(severity: NoticeSeverity): IconName {
  return severity === "info" ? "info" : severity === "blocked" ? "shield" : "warning";
}

/** A notice is read out at once unless it only informs. */
export function noticeRole(severity: NoticeSeverity): "note" | "alert" {
  return severity === "info" ? "note" : "alert";
}

/** The mark before a diff line. */
export function diffMarker(kind: DiffLine["kind"]): string {
  return kind === "added" ? "+ " : kind === "removed" ? "- " : "  ";
}

/** An answer's heading: two levels below the panel's own headings, h6 at most. */
export function headingTag(level: number): "h3" | "h4" | "h5" | "h6" {
  return `h${Math.min(6, level + 2)}` as "h3" | "h4" | "h5" | "h6";
}

/** The line under a finished answer: how long it took and what it used. */
export function turnMeta(turn: TurnViewModel): string {
  return [turn.durationText, turn.usageText].filter(Boolean).join(" · ");
}
