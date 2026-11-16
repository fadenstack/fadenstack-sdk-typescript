import { FadenstackAgent, emptyStopResult, nothingRan, type StopAllResult } from "@fadenstack/agents";

import { Observable } from "../observable.js";
import { englishStrings, type UiStrings } from "../strings.js";
import type { StringsSource } from "../skills/contracts.js";

export interface StopEverythingOptions {
  /** The agents that run now, asked at each press: they come and go. */
  agents: () => Iterable<FadenstackAgent>;
  /** The texts; English by default. */
  strings?: StringsSource;
  /** What stops them (a test's); `FadenstackAgent.stopAll` by default. */
  stop?: (agents: readonly FadenstackAgent[]) => Promise<StopAllResult>;
}

/**
 * "Stop everything", the emergency stop an app hosts in its tray menu or title bar (release plan 8.11): one press stops every running
 * chat of the agents it is given and ends their grants (`FadenstackAgent.stopAll`), then says what it did in one line. There is **no
 * confirmation**: it is the emergency stop. What the person allowed always stays. The agents come as a function because they come and
 * go. A skin binds to this class and holds no logic: the texts come from `strings` (say them again on `retext()`). .NET:
 * `StopEverythingViewModel`.
 */
export class StopEverythingViewModel extends Observable {
  readonly #agents: () => Iterable<FadenstackAgent>;
  readonly #strings: StringsSource;
  readonly #stop: (agents: readonly FadenstackAgent[]) => Promise<StopAllResult>;
  #busy = false;
  #result: StopAllResult | undefined;

  constructor(options: StopEverythingOptions) {
    super();
    this.#agents = options.agents;
    this.#strings = options.strings ?? (() => englishStrings);
    this.#stop = options.stop ?? ((agents) => FadenstackAgent.stopAll(agents));
  }

  get strings(): UiStrings {
    return this.#strings();
  }

  /** The accessible name and the tooltip's title: "Stop everything". */
  get name(): string {
    return this.strings.stopEverything;
  }

  /** The tooltip: what the button does and what stays. */
  get toolTip(): string {
    return this.strings.stopEverythingTip;
  }

  /** The stop is working. */
  get isBusy(): boolean {
    return this.#busy;
  }

  /** The stop can be pressed (not while it works). */
  get canStop(): boolean {
    return !this.#busy;
  }

  /** The counts of the last stop; undefined before the first press. */
  get result(): StopAllResult | undefined {
    return this.#result;
  }

  /** What the stop did: "Stopped 2 chats and ended 3 grants.", "Nothing was running.", or that the server could not be told. Empty before the first press. */
  get resultText(): string {
    return this.#busy ? this.strings.stopEverythingBusy : describeStopResult(this.#result, this.strings);
  }

  get hasResult(): boolean {
    return this.resultText.length > 0;
  }

  /** Stops everything at once, with no confirmation. */
  async stop(): Promise<void> {
    if (this.#busy) return;
    this.#busy = true;
    this.notify();
    let result: StopAllResult;
    try {
      result = await this.#stop([...this.#agents()].filter((a) => a !== undefined && a !== null));
    } catch {
      // What was local happened; the person is told what is known: nothing was counted.
      result = emptyStopResult();
    }
    this.#result = result;
    this.#busy = false;
    this.notify();
  }

  /** Says the last result again in a new language. */
  retext(): void {
    this.notify();
  }
}

/** The one line for a result, in `strings`'s language. .NET: `StopEverythingViewModel.Describe`. */
export function describeStopResult(result: StopAllResult | undefined, strings: UiStrings): string {
  if (!result) return "";
  if (result.grantsNotTold > 0) return strings.stopEverythingNotTold(strings.stopEverythingGrants(result.grantsNotTold));
  if (nothingRan(result)) return strings.stopEverythingNothing;
  const chats = strings.stopEverythingChats(result.turnsStopped);
  const grants = strings.stopEverythingGrants(result.grantsEnded);
  return result.turnsStopped > 0 && result.grantsEnded > 0 ? strings.stopEverythingBoth(chats, grants)
    : result.turnsStopped > 0 ? strings.stopEverythingChatsOnly(chats)
    : strings.stopEverythingGrantsOnly(grants);
}
