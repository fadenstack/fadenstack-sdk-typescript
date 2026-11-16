import type { AgentGrant } from "@fadenstack/client";

/** What `FadenstackAgent.stopAll()` did: counts, never content. .NET: `StopAllResult`. */
export interface StopAllResult {
  /** The turns that were running and were stopped: one per chat that was busy. */
  readonly turnsStopped: number;
  /**
   * The grants that ended: the server's grants of this device (time, work, plan, Bypass) and the tools the person had allowed for a
   * chat. Those the server could not be told about (`grantsNotTold`) are counted too: they ended on this device.
   */
  readonly grantsEnded: number;
  /** How many of `grantsEnded` are the chats' "for this chat" approvals. */
  readonly chatApprovalsEnded: number;
  /** The server's grants it could not be told about (offline, or it kept refusing): they ended on this device at once and end at their time on the server. */
  readonly grantsNotTold: number;
}

/** The result of a stop that found nothing. */
export function emptyStopResult(): StopAllResult {
  return { turnsStopped: 0, grantsEnded: 0, chatApprovalsEnded: 0, grantsNotTold: 0 };
}

/** The sum of two results (several agents). .NET: `StopAllResult.Plus`. */
export function addStopResults(a: StopAllResult, b: StopAllResult): StopAllResult {
  return {
    turnsStopped: a.turnsStopped + b.turnsStopped,
    grantsEnded: a.grantsEnded + b.grantsEnded,
    chatApprovalsEnded: a.chatApprovalsEnded + b.chatApprovalsEnded,
    grantsNotTold: a.grantsNotTold + b.grantsNotTold,
  };
}

/** Whether nothing ran and nothing was granted. .NET: `StopAllResult.NothingRan`. */
export function nothingRan(result: StopAllResult): boolean {
  return result.turnsStopped === 0 && result.grantsEnded === 0;
}

/** @internal What the part on this device left for the server. */
export interface StopPlan {
  readonly turns: number;
  readonly chatApprovals: number;
  readonly grants: AgentGrant[];
}
