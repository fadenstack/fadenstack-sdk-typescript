// What the sample page is made of, apart from the page itself: the agent, its one tool, the note list, and the two
// small stores the connection wizard asks of an app. No DOM here, so a test builds the same agent against the testing
// package's fakes.
import {
  AgentDefinition,
  FadenstackAgent,
  browserSecretProtector,
  defineTool,
  type ApprovalDecision,
  type ApprovalHandler,
  type ApprovalRequest,
  type SecretProtector,
} from "@fadenstack/agents";
import type { EndpointReport, ModelEndpoint, TokenProvider } from "@fadenstack/client";
import type { AcceptanceRecord, ConnectionResult, ConnectionStore, EndpointKeyStore } from "@fadenstack/ui";
import { provenanceModule } from "@fadenstack/provenance";

/** The agent's definition: what an app ships as its `contracts/*.json`. The one tool is a write tool, so it asks. */
export const DEFINITION = {
  slug: "web-sample",
  name: "Notes assistant",
  version: {
    instructions: "You are a helpful assistant on a web page. When the person asks you to remember or note something, call save_note with the text. Keep answers short.",
    host_tool_contract: [{ name: "save_note", risk: "write" }],
    ui: { greeting: "Ask me to save a note.", suggestions: ["Save a note: buy milk"] },
  },
} as const;

/** The page's own list of notes: the one thing the tool changes. */
export class Notes {
  readonly #items: string[] = [];
  readonly #listeners = new Set<() => void>();
  #snapshot: readonly string[] = [];

  get items(): readonly string[] {
    return this.#snapshot;
  }

  add(text: string): void {
    this.#items.push(text);
    this.#snapshot = [...this.#items];
    for (const listener of this.#listeners) listener();
  }

  /** For `useSyncExternalStore`. */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  getSnapshot = (): readonly string[] => this.#snapshot;
}

/** The longest note the tool keeps: the model's text is data, and the page shows it as text. */
export const MAX_NOTE_LENGTH = 500;

export interface SampleOptions {
  /** The endpoint the person picked in the wizard (or a fake's), with its check's report. */
  endpoint: ModelEndpoint;
  report?: EndpointReport | undefined;
  /** Answers the approval cards: the page's `ApprovalBroker`, or a function. */
  approvals: ApprovalHandler | ((request: ApprovalRequest, signal: AbortSignal) => Promise<ApprovalDecision>);
  notes: Notes;
}

/**
 * The sample's agent, standalone (no server): the person's own endpoint, the definition above, `save_note` (asks before it
 * writes), and content marking on (the records are signed on this device, so the chat's Copy marks an answer as AI-generated).
 * .NET: the console sample's `Program.cs`.
 */
export function buildSampleAgent(options: SampleOptions): FadenstackAgent {
  const saveNote = defineTool<{ text: string }>({
    name: "save_note",
    description: "Saves a note to the page's list.",
    toolClass: "write",
    parameters: { type: "object", properties: { text: { type: "string", description: "The note" } }, required: ["text"] },
    describe: ({ text }) => `note "${String(text).slice(0, 60)}" in this page's list`,
    run: ({ text }) => {
      const note = String(text).slice(0, MAX_NOTE_LENGTH);
      options.notes.add(note);
      return `Saved note ${options.notes.items.length}.`;
    },
  });
  return FadenstackAgent.createBuilder()
    .useEndpoint(options.endpoint, options.report)
    .useLocalProfile(AgentDefinition.fromJson(DEFINITION))
    .addTools(saveNote)
    .useApprovals(options.approvals)
    .use(provenanceModule())
    // "Remove my data" takes the page's own key store too (the SDK knows only its own stores).
    .useHostData({ indexedDb: [KEY_DATABASE], localStoragePrefixes: [KEY_PREFIX] })
    .build();
}

/**
 * Where the wizard keeps the connection. This page keeps nothing past a reload (it asks again), and never a key or a token:
 * the key goes to `BrowserKeyStore`.
 */
export class PageConnectionStore implements ConnectionStore {
  result: ConnectionResult | undefined;
  acceptance: AcceptanceRecord | undefined;

  saveServer(): Promise<void> {
    return Promise.resolve();
  }

  save(result: ConnectionResult): Promise<void> {
    this.result = result;
    return Promise.resolve();
  }

  saveAcceptance(record: AcceptanceRecord): Promise<void> {
    this.acceptance = record;
    return Promise.resolve();
  }

  signOut(): Promise<void> {
    this.result = undefined;
    return Promise.resolve();
  }
}

/** The `localStorage` keys that hold the sealed endpoint keys (one per endpoint origin), and the IndexedDB database of the seal key. */
export const KEY_PREFIX = "fadenstack-sample-key:";
export const KEY_DATABASE = "fadenstack-sample-keys";

/**
 * The key store for the endpoint's key, with the SDK's own protection: the key is sealed with the SDK's WebCrypto secret
 * protector (a non-extractable AES-GCM key in an IndexedDB database of its own, bound to the endpoint's address) and only the
 * sealed bytes are kept, in this page's localStorage. The token provider opens it when a request needs it; the page never holds
 * the key in a variable of its own. Where WebCrypto or IndexedDB is missing (an insecure page) it refuses to keep a key.
 * ASVS 5.0 V13 (secrets). .NET: `IEndpointKeyStore`.
 */
export class BrowserKeyStore implements EndpointKeyStore {
  readonly #protector: SecretProtector | undefined;

  constructor(protector?: SecretProtector) {
    this.#protector = protector ?? browserSecretProtector(KEY_DATABASE)?.protector;
  }

  async save(endpoint: URL, key: string): Promise<TokenProvider> {
    const protector = this.#protector;
    if (!protector) throw new Error("This page cannot keep a key safely.");
    const name = KEY_PREFIX + endpoint.origin;
    const sealed = await protector.protect(new TextEncoder().encode(key), name);
    globalThis.localStorage.setItem(name, toBase64(sealed));
    return {
      getAccessToken: async () => {
        const text = globalThis.localStorage.getItem(name);
        if (!text) throw new Error("The key is gone.");
        return new TextDecoder().decode(await protector.unprotect(fromBase64(text), name));
      },
      invalidate: () => Promise.resolve(),
    };
  }

  remove(endpoint: URL): Promise<void> {
    globalThis.localStorage.removeItem(KEY_PREFIX + endpoint.origin);
    return Promise.resolve();
  }
}

function toBase64(bytes: Uint8Array): string {
  let text = "";
  for (const b of bytes) text += String.fromCharCode(b);
  return btoa(text);
}

function fromBase64(text: string): Uint8Array {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
