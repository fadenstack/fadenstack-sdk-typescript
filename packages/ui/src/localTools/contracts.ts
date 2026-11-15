import type { LocalToolsCatalog } from "@fadenstack/agents";

import type { UiStrings } from "../strings.js";

// The Tools view's view models (sdk/51 F05). .NET: Fadenstack.UI.Tools. They are built on `LocalToolsCatalog` (`@fadenstack/agents`, which
// `@fadenstack/mcp` implements), so the UI package never imports a module. There is no dispatcher (no UI thread): the catalog tells
// `onChanged` and the page reads it again. The texts come from a function, so a language change is `retext()` away.

/** What the cards, the details and the sheets need of the page that owns them. */
export interface ToolsHost {
  readonly catalog: LocalToolsCatalog;
  /** The texts, asked for on every use so that a language change shows at once. */
  readonly strings: UiStrings;
  /** Plain http on the local network is permitted here (the profile and this computer's policy): the switch is offered. */
  readonly plainHttpPermitted: boolean;
  /** Reads the catalog again and brings the bar and the lists up to date in place. */
  refresh(): void;
  /** Runs a catalog call; one that rejects is not an unhandled rejection, and the page reads the catalog again so nothing shows a change that did not happen. */
  run(work: Promise<unknown>): Promise<void>;
  /** The switch of a server: it holds from the next message. */
  switchServer(label: string, on: boolean): Promise<void>;
  openDetails(label: string): void;
  closeDetails(): void;
  edit(label: string): Promise<void>;
  closeSheet(): void;
  importServers(): void;
}

/** True when `text` contains the filter (any case); an empty filter matches everything. */
export function containsText(text: string, filter: string): boolean {
  const wanted = filter.trim().toLocaleLowerCase();
  return wanted === "" || text.toLocaleLowerCase().includes(wanted);
}
