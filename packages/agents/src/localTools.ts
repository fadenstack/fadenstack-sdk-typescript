import type { AgentToolInfo } from "@fadenstack/client";

// What the Tools view and the MCP module share (sdk/51 F05). The layers keep `@fadenstack/ui` from importing a module and a module from
// importing `@fadenstack/ui` (the architecture test), so the contract sits here, in the core, as .NET puts it in Fadenstack.Agents
// (Fadenstack.LocalTools): `@fadenstack/ui` builds its view models on `LocalToolsCatalog`, and `@fadenstack/mcp` implements it over the
// person's servers (`McpToolsCatalog`). .NET: LocalTools.cs, without what only a program on a computer has: a browser starts no
// program, so there is no stdio server, environment, working folder or scan; and an import is a pasted configuration.

/** What the agent's local MCP policy says; the page's banner. */
export const ToolsPolicy = Object.freeze({
  /** Not known yet: nobody is signed in, or the agent has not started. */
  Unknown: "unknown",
  /** The organisation (or, standalone, the app) lets this assistant use MCP servers. */
  Allowed: "allowed",
  /** It has not allowed it. */
  NotAllowed: "notAllowed",
  /** Any server, for this person only. */
  DeveloperMode: "developerMode",
} as const);
export type ToolsPolicy = (typeof ToolsPolicy)[keyof typeof ToolsPolicy];

/** Where a local server stands. */
export const LocalServerState = Object.freeze({
  Off: "off",
  /** Switched on, and the agent has not attached it yet (it is attached at the start of the next message). */
  Starting: "starting",
  Running: "running",
  Failed: "failed",
  NotAllowed: "notAllowed",
} as const);
export type LocalServerState = (typeof LocalServerState)[keyof typeof LocalServerState];

/** The class a tool has now (what decides whether a call asks): a server's word alone never makes it `read`. */
export const LocalToolClass = Object.freeze({
  /** Not marked: every call asks. */
  Unknown: "unknown",
  /** Reads only: the server is trusted and says so, or the person raised the tool. */
  Read: "read",
  /** The person raised the tool to write. */
  Write: "write",
  /** The server says it may delete or overwrite: always asks, and no raise can lower it. */
  Destructive: "destructive",
} as const);
export type LocalToolClass = (typeof LocalToolClass)[keyof typeof LocalToolClass];

/** The person's raise of one tool, or none. */
export const LocalToolRaise = Object.freeze({
  /** No raise: the tool is as it arrives. */
  None: "none",
  Read: "read",
  Write: "write",
} as const);
export type LocalToolRaise = (typeof LocalToolRaise)[keyof typeof LocalToolRaise];

/** Why plain http to a server was refused (the MCP module's reason, in the view's terms). */
export const LocalPlainHttpRefusal = Object.freeze({
  /** The address is beyond this computer and the person has not turned on the switch. */
  NoOptIn: "noOptIn",
  /** The switch is on, but the address is not on the local network. */
  NotLocal: "notLocal",
  /** The server is sent a header value: never over plain http beyond this computer. */
  Secret: "secret",
  /** The agent's profile or this computer's policy does not allow plain http on the local network. */
  NotAllowed: "notAllowed",
} as const);
export type LocalPlainHttpRefusal = (typeof LocalPlainHttpRefusal)[keyof typeof LocalPlainHttpRefusal];

/** What a server says about one of its tools, with the class the tool has now and the person's raise. */
export interface LocalToolInfo {
  readonly name: string;
  readonly description: string;
  readonly title?: string | undefined;
  /** The server's own word: it counts only from a server marked trusted. */
  readonly readOnly?: boolean | undefined;
  /** The server's own word: it always counts, and it is a floor no raise goes below. */
  readonly destructive?: boolean | undefined;
  readonly idempotent?: boolean | undefined;
  readonly openWorld?: boolean | undefined;
  /** The class the tool has now. */
  readonly class: LocalToolClass;
  /** The person's raise of this tool. */
  readonly raise: LocalToolRaise;
}

/** One of the person's local servers with where it stands. Never carries a secret. */
export interface LocalServerInfo {
  readonly label: string;
  /** The address (a browser starts no program). */
  readonly where: string;
  readonly enabled: boolean;
  readonly state: LocalServerState;
  /** The last error (`failed`) or the policy's reason (`notAllowed`). */
  readonly detail?: string | undefined;
  /** The server changed its tools after it was attached. */
  readonly toolsChanged: boolean;
  /** Where it came from: "typed" or the configuration it was imported from (`mcpServers`, `servers`). */
  readonly origin: string;
  readonly tools: readonly LocalToolInfo[];
  /** The names, never the values, of the headers the server takes. */
  readonly secretNames: readonly string[];
  /** The names among `secretNames` that have no value. */
  readonly missingValues: readonly string[];
  /** The longest one call may take, in seconds. */
  readonly callTimeoutSeconds: number;
  /** When the server was seen running first; undefined while it is not running. */
  readonly runningSince?: Date | undefined;
  /** The server's read-only hints count (the person, or the administrator, marked it trusted). */
  readonly trusted: boolean;
  /** The server is an address over plain http beyond this computer: the switch "Allow plain http on the local network" applies. */
  readonly plainHttpApplies: boolean;
  /** The person's switch is on. */
  readonly plainHttpInLan: boolean;
  /** Why a connection over plain http was refused; undefined when it was not. */
  readonly plainHttpRefusal?: LocalPlainHttpRefusal | undefined;
}

/** A header's name and value while the person edits them. */
export interface SecretPairDraft {
  name: string;
  /** The new value. Empty with `isKept`: the saved value stays. */
  value: string;
  /** The value is the one saved earlier, which the page never sees (it shows dots). */
  isKept: boolean;
}

/** A server as the add and edit sheet holds it. */
export interface ServerDraft {
  label: string;
  enabled: boolean;
  url: string;
  headers: SecretPairDraft[];
  callTimeoutSeconds: number;
}

/** A new, empty draft. */
export function newServerDraft(): ServerDraft {
  return { label: "", enabled: true, url: "", headers: [], callTimeoutSeconds: 120 };
}

/** Forgets every typed header value of a draft (a draft is not kept once it was saved or tested). */
export function clearServerSecrets(draft: ServerDraft): void {
  for (const pair of draft.headers) pair.value = "";
}

/** What is wrong with a draft. */
export const ServerProblem = Object.freeze({
  None: "none",
  LabelMissing: "labelMissing",
  LabelInvalid: "labelInvalid",
  LabelTaken: "labelTaken",
  NameInvalid: "nameInvalid",
  ValueInvalid: "valueInvalid",
  AddressMissing: "addressMissing",
  AddressInvalid: "addressInvalid",
  TimeoutOutOfRange: "timeoutOutOfRange",
  TooManyHeaders: "tooManyHeaders",
  /** Plain http beyond this computer with a header value: headers hold tokens, so they need https. */
  PlainHttpWithHeaders: "plainHttpWithHeaders",
  /** Plain http to an address outside the local network. */
  PlainHttpNotLocal: "plainHttpNotLocal",
} as const);
export type ServerProblem = (typeof ServerProblem)[keyof typeof ServerProblem];

/** How a test of a server went. */
export const TestOutcome = Object.freeze({
  /** The policy does not allow local servers: nothing was sent. */
  NotAllowed: "notAllowed",
  Started: "started",
  Failed: "failed",
} as const);
export type TestOutcome = (typeof TestOutcome)[keyof typeof TestOutcome];

/** The result of a test. `error` is a short cleaned line, never a secret. */
export interface ServerTestInfo {
  readonly outcome: TestOutcome;
  readonly tools: readonly string[];
  readonly error?: string | undefined;
  /** Why plain http to the server was refused, when it was: nothing was sent. */
  readonly plainHttp?: LocalPlainHttpRefusal | undefined;
}

/** Why a pasted configuration could not be read. */
export const ImportProblem = Object.freeze({
  None: "none",
  /** Nothing was pasted. */
  Empty: "empty",
  NotJson: "notJson",
  NoServerList: "noServerList",
  TooLarge: "tooLarge",
} as const);
export type ImportProblem = (typeof ImportProblem)[keyof typeof ImportProblem];

/** Something the person should know about a server before they tick it. */
export const ImportNote = Object.freeze({
  /** One or more headers were left out (a placeholder or not text); `detail` names them. */
  HeadersLeftOut: "headersLeftOut",
} as const);
export type ImportNote = (typeof ImportNote)[keyof typeof ImportNote];

/** Why a server of a pasted configuration is not offered. */
export const ImportSkipReason = Object.freeze({
  /** It starts a program, which a browser cannot do. */
  Program: "program",
  /** It uses the old SSE transport. */
  Sse: "sse",
  /** Plain http beyond this computer: it is added by hand, with the switch. */
  NetworkServer: "networkServer",
  /** It has no address. */
  NothingToStart: "nothingToStart",
  /** The person's list already has a server of that name. */
  LabelTaken: "labelTaken",
  /** It breaks a rule; `problem` says which. */
  NotValid: "notValid",
  NotUnderstood: "notUnderstood",
} as const);
export type ImportSkipReason = (typeof ImportSkipReason)[keyof typeof ImportSkipReason];

export interface ImportCandidateInfo {
  readonly label: string;
  readonly where: string;
  readonly notes: readonly ImportNote[];
  /** The names of the headers that were left out. */
  readonly detail?: string | undefined;
}

export interface ImportSkipInfo {
  readonly name: string;
  readonly reason: ImportSkipReason;
  /** The rule it breaks, with `notValid`. */
  readonly problem?: ServerProblem | undefined;
}

/**
 * What was found in a pasted configuration. Nothing is copied until `LocalToolsCatalog.import`; an import never turns on the
 * plain-http switch or marks a server trusted, and every server comes in switched off. The pasted text may hold header values: the
 * preview carries names only.
 */
export interface ImportPreview {
  readonly problem: ImportProblem;
  readonly servers: readonly ImportCandidateInfo[];
  readonly skipped: readonly ImportSkipInfo[];
}

export const CloudToolsStatus = Object.freeze({
  /** Nobody is signed in or the agent has not started. */
  NotSignedIn: "notSignedIn",
  Listed: "listed",
  /** The server does not list its tools (an older one). */
  NotListed: "notListed",
  /** The list could not be loaded right now. */
  Unavailable: "unavailable",
} as const);
export type CloudToolsStatus = (typeof CloudToolsStatus)[keyof typeof CloudToolsStatus];

/** A tool of the organisation's server, as "On your server" lists it. */
export interface CloudToolInfo {
  readonly name: string;
  readonly server: string;
  readonly description: string;
  /** This assistant's tool rules let it be offered and run. */
  readonly allowed: boolean;
  /** Switched on; an administrator may have switched it off. */
  readonly enabled: boolean;
}

export interface CloudToolsResult {
  readonly status: CloudToolsStatus;
  readonly tools: readonly CloudToolInfo[];
}

/** The cloud tools of an agent's server as the page lists them (`AgentToolInfo` carries the same fields). */
export function cloudToolOf(tool: AgentToolInfo): CloudToolInfo {
  return { name: tool.name, server: tool.server, description: tool.description, allowed: tool.allowed, enabled: tool.enabled };
}

/**
 * Everything the Tools view shows and changes (sdk/51 F05): the person's local MCP servers with their tools, and the cloud tools of
 * their server. Secrets of a server never leave the host: a draft carries only names and "kept" marks, and the host puts the saved
 * values back when it stores the draft. The lists are a snapshot the catalog keeps up to date (`refresh`, and `onChanged` tells when it
 * moved), because a browser's database answers asynchronously. .NET: `ILocalToolsCatalog`.
 */
export interface LocalToolsCatalog {
  /** The agent is running for a signed-in person: the lists are real. */
  readonly signedIn: boolean;
  readonly policy: ToolsPolicy;
  /** The list of servers is written to the browser's database (header values sealed); false: it is kept in memory until the page closes. */
  readonly serversKeptOnDisk: boolean;
  /** The saved list could not be read; it starts empty. */
  readonly serversUnreadable: boolean;
  readonly localServers: readonly LocalServerInfo[];
  /**
   * Plain http on the local network is allowed here: the agent's profile says `local_mcp.plain_http: allow` and this computer's
   * policy allows it (`plainHttpPermitted`). The person's switch per server is still needed. False: the view hides the switch.
   */
  readonly plainHttpPermitted: boolean;
  /** The person's own marks count (standalone); false: an administrator's do, and the view shows them without a way to change them. */
  readonly marksAreYours: boolean;

  /** Reads the person's servers again; the lists are up to date when it returns. */
  refresh(): Promise<void>;
  /** Loads the cloud tools for this assistant (`GET /v1/agents/{agent}/tools`). */
  getCloudTools(signal?: AbortSignal): Promise<CloudToolsResult>;
  /** Switches a server on or off; it holds from the next message. */
  setEnabled(label: string, enabled: boolean): Promise<void>;
  /** Marks a server trusted or not: only a trusted server's read-only hints count. From the next message. */
  setTrusted(label: string, trusted: boolean): Promise<void>;
  /** The person's raise of one tool: read, write or none. A tool the server says is destructive is never lowered: the raise is not kept for it. */
  setToolClass(label: string, tool: string, raise: LocalToolRaise): Promise<void>;
  /**
   * The switch "Allow plain http on the local network" of a server. Turning it on needs the version of the warning the person
   * confirmed just before (`warningVersion`); the problem when the server cannot have it.
   */
  setPlainHttpInLan(label: string, on: boolean, warningVersion?: string): Promise<ServerProblem>;
  /** A draft of a saved server for the edit sheet (header names, never values); undefined for an unknown label. */
  getDraft(label: string): Promise<ServerDraft | undefined>;
  /** Checks a draft without saving it. `originalLabel` is the server being edited, undefined for a new one. */
  validate(draft: ServerDraft, originalLabel: string | undefined): ServerProblem;
  /** Saves a new server (`originalLabel` undefined) or replaces one; the problem when it is not valid. */
  save(originalLabel: string | undefined, draft: ServerDraft): Promise<ServerProblem>;
  remove(label: string): Promise<void>;
  /** Connects to the draft's server for a moment, lists its tools and closes. Nothing is sent where the policy does not allow it. */
  test(draft: ServerDraft, originalLabel: string | undefined, signal?: AbortSignal): Promise<ServerTestInfo>;
  /** Reads a pasted configuration (`mcpServers` or `servers`). */
  readImport(text: string): Promise<ImportPreview>;
  /** Adds the ticked servers (by their labels in `preview`), every one switched off; returns how many were added. */
  import(preview: ImportPreview, labels: readonly string[]): Promise<number>;
  /** Stops the server and starts it again (it holds from the next message). */
  restart(label: string): Promise<void>;
  /** Servers, their states, the policy or the signed-in agent changed. */
  onChanged(listener: () => void): () => void;
}
