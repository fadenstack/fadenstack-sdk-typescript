import type {
  EndpointCheckOptions,
  EndpointPlace,
  EndpointPreset,
  EndpointReport,
  ModelEndpoint,
  PairingExport,
  SignedInUser,
  TokenProvider,
} from "@fadenstack/client";
import type { MachinePolicy } from "@fadenstack/agents";

// The connection wizard's names and contracts (sdk/51 F15, I15 §1-§3). .NET: Fadenstack.UI.Wizard (WizardContracts.cs). The
// enums are frozen string consts, as the SDK has them elsewhere; the values are .NET's names in camelCase. Times are ms
// since the epoch, durations ms, and a CancellationToken is an AbortSignal.

/** How the wizard is opened (I15 §1). */
export const WizardEntry = Object.freeze({
  /** The first start: the app's steps, then the choice. */
  FirstRun: "firstRun",
  /** The server is known (a machine policy's, a saved one): straight to a pairing code (`WizardOptions.server`). */
  ServerKnown: "serverKnown",
  /** The same, with the "your sign-in ended" banner. */
  ReSignIn: "reSignIn",
  /** Settings > Connection: change, connect to the organisation, sign out, remove the endpoint. */
  Settings: "settings",
} as const);
export type WizardEntry = (typeof WizardEntry)[keyof typeof WizardEntry];

/** Where the wizard stands: one value per state of I15 §1-§3; a skin draws one view per step. */
export const WizardStep = Object.freeze({
  /** The app's own steps before the choice (`WizardPoint.BeforeChoice`); `appStep` is the one running. */
  BeforeChoice: "beforeChoice",
  /** "Connect to my organisation", "Use my own AI", the app's demo: what the app offers and the policy allows. */
  Choose: "choose",
  Settings: "settings",
  /** Sign out, or remove the endpoint: the person confirms, and says whether the chats kept here go too. */
  SignOut: "signOut",
  // Path A: connect to my organisation.
  /** The server's address (locked when the machine policy names it). */
  ServerAddress: "serverAddress",
  /** The app's step before the server is checked (`WizardPoint.BeforeServerCheck`). */
  AppPrecondition: "appPrecondition",
  /** `GET /api/health`, at most 15 s. */
  Checking: "checking",
  Unreachable: "unreachable",
  /** The server's certificate is not trusted: ask IT. A CA comes only from the policy or the app's settings. */
  CertificateNotTrusted: "certificateNotTrusted",
  /** Something answers, but not like the platform. */
  NotFadenstack: "notFadenstack",
  /** The address answers; it is saved (and an app that restarts onto a new server finishes here). */
  ServerAccepted: "serverAccepted",
  /** A pairing code is being asked for. */
  PairStarting: "pairStarting",
  /** The first pairing request failed: unreachable, rate limited, page elsewhere, a server error. */
  StartFailed: "startFailed",
  /** The server has no pairing (404, 405). */
  ServerTooOld: "serverTooOld",
  /** The code is shown; the wizard waits for the approval in the console. */
  PairCode: "pairCode",
  /** Approved: the agents' sign-ins are collected next. */
  Approved: "approved",
  Denied: "denied",
  Expired: "expired",
  /** The wait for the approval failed for good. */
  PairFailed: "pairFailed",
  /** The sign-in is collected for each of the app's agents. */
  Redeeming: "redeeming",
  /** A required agent was refused (`WizardOptions.requiredAgents`). */
  NoAccess: "noAccess",
  /** The password sign-in (`WizardOptions.passwordFallback`). */
  Password: "password",
  PasswordError: "passwordError",
  /** "Signed in as ...", for a moment, then the app gets the result. */
  SignedIn: "signedIn",
  // Path B: use my own AI.
  /** Where the data goes, the provider's terms, the standalone notice, the consent box (unticked), the search consent. */
  OwnAccept: "ownAccept",
  /** Looking for model servers on this computer (only with the person's consent). */
  OwnSearching: "ownSearching",
  /** A server found here, a preset, or an address typed by hand. */
  OwnPick: "ownPick",
  /** Plain http to the local network: the person confirms; never with a key (D3). */
  OwnPlainHttp: "ownPlainHttp",
  /** The key, straight into the key store. */
  OwnKey: "ownKey",
  /** The app's step before every check (`WizardPoint.BeforeEndpointCheck`; Chrome's host permission). */
  BeforeCheck: "beforeCheck",
  /** The endpoint check (F03). */
  OwnChecking: "ownChecking",
  /** The check found the endpoint unusable (`problem`). */
  OwnFailed: "ownFailed",
  /** The endpoint refused this origin (403): how to allow it (Ollama's `OLLAMA_ORIGINS`). */
  OwnHelp: "ownHelp",
  /** What the check found, in plain words. */
  OwnResult: "ownResult",
  /** The model to use. */
  OwnModel: "ownModel",
  /** The endpoint is ready. */
  OwnDone: "ownDone",
  /** The app's steps after connecting (`WizardPoint.AfterConnect`). */
  AfterConnect: "afterConnect",
  /** The wizard is over: `outcome` says how. */
  Finished: "finished",
} as const);
export type WizardStep = (typeof WizardStep)[keyof typeof WizardStep];

/** How the wizard ended. */
export const WizardOutcome = Object.freeze({
  /** Not ended yet. */
  None: "none",
  /** Connected: `result` is saved; the app builds the agent (`useServer` or `useEndpoint`). */
  Connected: "connected",
  /** The person chose the app's demo. */
  Demo: "demo",
  /** The address answered and is saved; the app restarts onto it and opens the wizard as `WizardEntry.ServerKnown`. */
  RestartOnServer: "restartOnServer",
  /** Signed out, or the endpoint removed: the app cleared its tokens or key. */
  SignedOut: "signedOut",
  /** Closed without a connection. */
  Closed: "closed",
} as const);
export type WizardOutcome = (typeof WizardOutcome)[keyof typeof WizardOutcome];

/** Where the app's own steps run (`WizardStepHandler`). */
export const WizardPoint = Object.freeze({
  /** Before the choice, on the first start (the desktop's licence). */
  BeforeChoice: "beforeChoice",
  /** Before the server is checked (a permission the app needs to reach it). */
  BeforeServerCheck: "beforeServerCheck",
  /** Before every endpoint check, inside the gesture that pressed "Check" (Chrome's host permission). */
  BeforeEndpointCheck: "beforeEndpointCheck",
  /** After connecting, before the result is saved. */
  AfterConnect: "afterConnect",
} as const);
export type WizardPoint = (typeof WizardPoint)[keyof typeof WizardPoint];

/** Which way the app is connected. */
export const ConnectionMode = Object.freeze({
  /** To the organisation's Fadenstack server. */
  Server: "server",
  /** To the person's own model endpoint (standalone). */
  Endpoint: "endpoint",
} as const);
export type ConnectionMode = (typeof ConnectionMode)[keyof typeof ConnectionMode];

/** Whether one of the app's agents is signed in. */
export const AgentAccess = Object.freeze({
  /** Signed in: its tokens are in the token store. */
  Approved: "approved",
  /** The person did not approve it, or the server refused it. */
  Refused: "refused",
  /** An older server signs in one agent per pairing: this one needs a pairing of its own. */
  Left: "left",
} as const);
export type AgentAccess = (typeof AgentAccess)[keyof typeof AgentAccess];

/** Why a typed address was not taken. */
export const AddressProblem = Object.freeze({
  None: "none",
  /** Not an http(s) address, or one with a user name in it. */
  Invalid: "invalid",
  /** Plain http to another computer: https is needed (or, for an endpoint, the local network with the opt-in). */
  HttpsRequired: "httpsRequired",
  /** The machine policy's `endpoints` list does not have it. */
  NotAllowed: "notAllowed",
  /** The machine policy's `plainHttp` is forbidden. */
  PlainHttpForbidden: "plainHttpForbidden",
  /** A key over plain http to the local network: never (D3). */
  KeyNeedsHttps: "keyNeedsHttps",
} as const);
export type AddressProblem = (typeof AddressProblem)[keyof typeof AddressProblem];

/** Why the first pairing request failed (`WizardStep.StartFailed`). */
export const StartFailure = Object.freeze({
  Unreachable: "unreachable",
  CertificateNotTrusted: "certificateNotTrusted",
  /** Too many pairings from this address: `retryAt` says when to try again. */
  RateLimited: "rateLimited",
  /** The server named its sign-in page on another address than its own (a proxy's `Host` or `X-Forwarded-Proto`). */
  PageElsewhere: "pageElsewhere",
  ServerError: "serverError",
} as const);
export type StartFailure = (typeof StartFailure)[keyof typeof StartFailure];

/** Why the password sign-in failed (`WizardStep.PasswordError`). */
export const PasswordFailure = Object.freeze({
  BadCredentials: "badCredentials",
  HttpsRequired: "httpsRequired",
  NotFadenstack: "notFadenstack",
  Unreachable: "unreachable",
  CertificateNotTrusted: "certificateNotTrusted",
  Other: "other",
} as const);
export type PasswordFailure = (typeof PasswordFailure)[keyof typeof PasswordFailure];

/** What an app step may look at. */
export interface WizardStepContext {
  /** Where it runs. */
  readonly point: WizardPoint;
  /** The server's address, on path A. */
  readonly server?: URL | undefined;
  /** The endpoint, on path B (its key is a provider over the key store, never the key). */
  readonly endpoint?: ModelEndpoint | undefined;
  /** The connection, after connecting. */
  readonly result?: ConnectionResult | undefined;
}

/**
 * One of the app's own steps (F15): the desktop's licence, Chrome's host permission. It runs at its `point`; a skin may draw
 * it while `appStep` is this step. .NET: `IWizardStep`.
 */
export interface WizardStepHandler {
  readonly point: WizardPoint;
  /**
   * Runs the step. True goes on; false stops the flow: before the choice it closes the wizard, before a check it goes back to
   * the address, after connecting nothing is saved and the wizard goes back to its start. A step that throws counts as false.
   * **A step at `BeforeEndpointCheck` is called inside the gesture that pressed the button** (before the wizard's first
   * `await` where it can be), so `chrome.permissions.request` is allowed.
   */
  run(context: WizardStepContext, signal: AbortSignal): boolean | Promise<boolean>;
}

/** An agent's sign-in. */
export interface AgentSignIn {
  readonly agent: string;
  readonly access: AgentAccess;
}

/**
 * What the wizard connected (F15): the app saves it (`ConnectionStore`) and builds the agent from it. Keys and tokens are
 * never in it; they are in the key and token stores.
 */
export interface ConnectionResult {
  readonly mode: ConnectionMode;
  /** The server, on path A. */
  readonly server?: URL | undefined;
  /** Who signed in, when the server said. */
  readonly person?: SignedInUser | undefined;
  /** Each of the app's agents and whether it is signed in. */
  readonly agents?: readonly AgentSignIn[] | undefined;
  /** The endpoint, on path B, with the model picked; its `key` reads the key store. */
  readonly endpoint?: ModelEndpoint | undefined;
  /** The check's report, kept with the connection (the records cite it, F10). */
  readonly report?: EndpointReport | undefined;
  /** The preset it came from (`EndpointPreset.id`), if any. */
  readonly presetId?: string | undefined;
}

/** The person's acceptance of the own-AI terms, kept on the device (F15): what, when, in which language, for which mode. */
export interface AcceptanceRecord {
  readonly termsVersion: string;
  /** Ms since the epoch. */
  readonly acceptedAt: number;
  readonly language: string;
  readonly mode: string;
}

/**
 * Where the app keeps the connection (F15, layer 2): the desktop's `settings.json`, Office's settings, Chrome's storage.
 * Never a key or token. .NET: `IConnectionStore`.
 */
export interface ConnectionStore {
  /** Saves the server the person typed once it answers (before the pairing, so an app that restarts finds it). */
  saveServer(server: URL, signal: AbortSignal): Promise<void>;
  /** Saves the finished connection. */
  save(result: ConnectionResult, signal: AbortSignal): Promise<void>;
  /** Keeps the acceptance record. */
  saveAcceptance(record: AcceptanceRecord, signal: AbortSignal): Promise<void>;
  /**
   * Signs out (path A: revoke at the server as far as it can, delete the tokens) or removes the endpoint (its key), and
   * forgets the connection; the chats kept on this computer only with `deleteLocalChats`.
   */
  signOut(deleteLocalChats: boolean, signal: AbortSignal): Promise<void>;
}

/**
 * The key store for endpoint keys (Chrome's WebCrypto key over `chrome.storage`, DPAPI, Keychain). The wizard hands the key
 * over at once and keeps only "a key is set". .NET: `IEndpointKeyStore`.
 */
export interface EndpointKeyStore {
  /** Saves the key for the endpoint; the provider reads it from the store when a request needs it. */
  save(endpoint: URL, key: string, signal: AbortSignal): Promise<TokenProvider>;
  /** Removes the endpoint's key. */
  remove(endpoint: URL, signal: AbortSignal): Promise<void>;
}

/** Opens a page in the person's browser (http and https only). .NET: `ILinkOpener`. */
export interface LinkOpener {
  tryOpen(address: URL): boolean;
}

/** The wizard's time: now, and a timer (the code's countdown, the "signed in" moment). Tests move it by hand. .NET: `IWizardClock`. */
export interface WizardClock {
  /** Ms since the epoch. */
  now(): number;
  /** Runs `action` once after `delayMs`; the returned function stops it. */
  after(delayMs: number, action: () => void): () => void;
}

/**
 * A pairing the server started, as the wizard shows it; `handle` keeps what the client polls with (the secret).
 * `toString()` and `toJSON()` say only that this is a pairing and when it ends: no code.
 */
export interface PairingTicket {
  /** The code to show, e.g. `BDWP-HTQX`. */
  readonly userCode: string;
  /** The console page. */
  readonly verificationUri: URL;
  /** The page with the code filled in: what the browser opens. */
  readonly verificationUriComplete: URL;
  /** When the code expires, in ms since the epoch, on this device's clock. */
  readonly expiresAt: number;
  /** The agents the pairing asked for, the main one first. */
  readonly agents: readonly string[];
  /** The client's own object (the pairing and its start); opaque to the wizard. */
  readonly handle?: unknown;
}

/** Makes a `PairingTicket` whose text and JSON hold no code. */
export function createPairingTicket(init: PairingTicket): PairingTicket {
  const ticket = { ...init };
  Object.defineProperty(ticket, "toString", {
    value: () => `PairingTicket(expires ${new Date(init.expiresAt).toISOString()})`, enumerable: false,
  });
  Object.defineProperty(ticket, "toJSON", { value: () => ({ expiresAt: init.expiresAt }), enumerable: false });
  return Object.freeze(ticket);
}

/** An approval: who approved it, and the agents collected so far (the main one). */
export interface PairingApproval {
  readonly person?: SignedInUser | undefined;
  readonly agents: readonly AgentSignIn[];
}

/**
 * A pairing kept while the panel is closed (`PairingKeeper`): the server, when it ends, and what `ServerSignIn.export` made,
 * **which holds the pairing code: a secret for session storage only, never a log or a file** (ASVS 5.0 V13).
 */
export interface SavedPairing {
  /** The server's address (`URL.href`). */
  readonly server: string;
  /** When the code expires, in ms since the epoch. */
  readonly expiresAt: number;
  readonly pairing: PairingExport;
}

/**
 * Keeps a pairing across a closed panel (I15 §2): Chrome's side panel can close while the person approves in the console. The
 * app keeps it in `chrome.storage.session`, which lives in memory for the browser session. The wizard keeps it when the code
 * shows, forgets it when the wait ends one way or another or is cancelled, and resumes it on start. TS only (.NET's window
 * keeps its process).
 */
export interface PairingKeeper {
  keep(saved: SavedPairing): void | Promise<void>;
  restore(): SavedPairing | undefined | Promise<SavedPairing | undefined>;
  forget(): void | Promise<void>;
}

/**
 * The server side of path A, as the wizard drives it (`createServerSignIn` over the SDK's pairing, password login and
 * health check; tests pass a fake). The failures are the SDK's typed errors: `FadenstackUnreachableError`,
 * `ServerCertificateError`, `FadenstackRateLimitedError`, `FadenstackPairingUnsupportedError`,
 * `FadenstackPairingPageElsewhereError`, `FadenstackPairingDeniedError`, `FadenstackPairingExpiredError`,
 * `FadenstackBadCredentialsError`, `FadenstackHttpsRequiredError`, and a `FadenstackApiError` with code `not_fadenstack`.
 * .NET: `IServerSignIn`.
 */
export interface ServerSignIn {
  /** `GET {server}/api/health`: 200 and JSON within 15 s, or a typed error. */
  check(server: URL, signal: AbortSignal): Promise<void>;
  /** Asks for a pairing code for the app's agents. */
  start(server: URL, signal: AbortSignal): Promise<PairingTicket>;
  /** Waits for the approval and collects the main agent; `onRetrying` is told when it is retrying (and when it is not). */
  wait(ticket: PairingTicket, onRetrying: (retrying: boolean) => void, signal: AbortSignal): Promise<PairingApproval>;
  /** Collects one more of the pairing's agents after the approval. */
  redeem(ticket: PairingTicket, agent: string, signal: AbortSignal): Promise<AgentSignIn>;
  /** The password sign-in (an older server, or the person's choice): every agent of the app. */
  signInWithPassword(server: URL, email: string, password: string, signal: AbortSignal): Promise<PairingApproval>;
  /** What a `PairingKeeper` keeps for `ticket` (with the pairing code: a secret); absent when this sign-in cannot resume. TS only. */
  export?(ticket: PairingTicket): PairingExport | undefined;
  /** The ticket again from what `export` made; throws when it is not readable or its pages are not the server's own. TS only. */
  resume?(server: URL, saved: PairingExport): PairingTicket;
}

/** A model server found on this computer. .NET: `LocalEndpoint`. */
export interface LocalEndpoint {
  readonly baseUrl: URL;
  readonly preset?: EndpointPreset | undefined;
  readonly models?: readonly string[] | undefined;
}

/**
 * The endpoint side of path B (`createEndpointChecker` over `EndpointCheck`; tests pass a fake). .NET: `IEndpointChecker`.
 */
export interface EndpointChecker {
  /** Model servers on this computer; only called after the person agreed. A browser cannot scan: the default finds none. */
  findLocal(signal: AbortSignal): Promise<readonly LocalEndpoint[]>;
  /**
   * Where the address points. **Synchronous here** (a browser cannot resolve names, `EndpointCheck.placeOf`): the contract
   * allows a promise for parity with .NET, and the wizard takes a plain answer without waiting, so the app's step before the
   * check stays inside the gesture.
   */
  placeOf(baseUrl: URL, signal: AbortSignal): EndpointPlace | Promise<EndpointPlace>;
  /** The endpoint check (F03). */
  check(endpoint: ModelEndpoint, signal: AbortSignal, options?: EndpointCheckOptions): Promise<EndpointReport>;
}

/** What the app declares, and what the wizard needs to run (F15). Every field is optional; the defaults are .NET's. .NET: `WizardOptions`. */
export interface WizardOptions {
  /** Default `WizardEntry.FirstRun`. */
  entry?: WizardEntry;
  /** The app offers "Connect to my organisation" (default true). */
  offersServer?: boolean;
  /** The app offers "Use my own AI" (default true). */
  offersOwnAi?: boolean;
  /** The app has a demo (default false). */
  offersDemo?: boolean;
  /** The app's name, for the texts. */
  appName?: string;
  /** The app's licence and privacy texts. */
  licenceLink?: URL | undefined;
  privacyLink?: URL | undefined;
  /** The machine policy (F09): its server opens path A with the address locked; `standalone: forbidden` hides own AI; `endpoints` narrows the picks; `plainHttp`. */
  policy?: MachinePolicy;
  /** The server, for `WizardEntry.ServerKnown` and `ReSignIn`; a policy's server wins. */
  server?: URL | undefined;
  /** The connection the app has now, for Settings. */
  current?: ConnectionResult | undefined;
  /** The agents the app signs in with one approval, the main one first (Office's four). */
  agents?: readonly string[];
  /** The agents that must be signed in, or `WizardStep.NoAccess`; the main agent when empty. */
  requiredAgents?: readonly string[];
  /** Offer the password sign-in (Office and Chrome; not the desktop). */
  passwordFallback?: boolean;
  /** The app restarts onto a new server (the desktop): the wizard finishes at `WizardStep.ServerAccepted`. */
  restartsOnNewServer?: boolean;
  /**
   * The app can search this computer for model servers (default true, as .NET). A browser cannot: the default checker finds
   * none, so a Chrome app sets false and shows no search box.
   */
  canSearchThisComputer?: boolean;
  /** The version of the own-AI terms the person accepts, kept in the acceptance record. */
  termsVersion?: string;
  /** The app's own steps. */
  steps?: readonly WizardStepHandler[];
  /** How long "Signed in as ..." shows, in ms (default 1500). */
  signedInPauseMs?: number;
  /** The check's options (the context the agent needs). */
  checkOptions?: EndpointCheckOptions | undefined;
  /** Keeps a pairing while the panel is closed (Chrome: `chrome.storage.session`). TS only; see `PairingKeeper`. */
  pairingKeeper?: PairingKeeper | undefined;
}
