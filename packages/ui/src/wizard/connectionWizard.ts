import { MachinePolicy, PolicyAccess } from "@fadenstack/agents";
import {
  EndpointDialect,
  EndpointPlace,
  EndpointPreset,
  EndpointProblem,
  FadenstackApiError,
  FadenstackBadCredentialsError,
  FadenstackHttpsRequiredError,
  FadenstackPairingDeniedError,
  FadenstackPairingExpiredError,
  FadenstackPairingPageElsewhereError,
  FadenstackPairingUnsupportedError,
  FadenstackRateLimitedError,
  FadenstackUnreachableError,
  ServerCertificateError,
  hostScope,
  isAbortError,
  type EndpointReport,
  type ModelEndpoint,
  type SignedInUser,
  type TokenProvider,
} from "@fadenstack/client";

import { Observable } from "../observable.js";
import type { Clipboard } from "../services.js";
import { englishStrings, type UiStrings } from "../strings.js";
import {
  AddressProblem,
  AgentAccess,
  ConnectionMode,
  PasswordFailure,
  StartFailure,
  WizardEntry,
  WizardOutcome,
  WizardPoint,
  WizardStep,
  type AgentSignIn,
  type ConnectionResult,
  type ConnectionStore,
  type EndpointChecker,
  type EndpointKeyStore,
  type LinkOpener,
  type LocalEndpoint,
  type PairingApproval,
  type PairingTicket,
  type SavedPairing,
  type ServerSignIn,
  type WizardClock,
  type WizardOptions,
  type WizardStepContext,
  type WizardStepHandler,
} from "./contracts.js";
import { createEndpointChecker, createSystemClock } from "./services.js";

// The connection wizard (sdk/51 F15, I15): one state machine for "Connect to my organisation" (pairing, the password
// fallback) and "Use my own AI" (acceptance, the key, the check, the model), and for Settings > Connection. .NET:
// Fadenstack.UI.Wizard.ConnectionWizardViewModel, step for step. There is no UI thread here, so no dispatcher: state changes
// and `notify()` happen where the answers arrive.

/** The services the wizard runs on; every one is optional, the path that is not offered does not need its own. */
export interface WizardServices {
  /** Path A's server side (`createServerSignIn`); needed when the app offers the server path. */
  server?: ServerSignIn | undefined;
  /** The key store for endpoint keys; needed when the app offers its own AI. */
  keys?: EndpointKeyStore | undefined;
  /** Path B's checks; `createEndpointChecker(options.checkOptions)` by default. */
  checker?: EndpointChecker | undefined;
  /** The time and the timers; `createSystemClock()` by default. */
  clock?: WizardClock | undefined;
  /** For "copy the code". */
  clipboard?: Clipboard | undefined;
  /** Opens the pairing page in the browser. */
  links?: LinkOpener | undefined;
  /**
   * The language the acceptance record names (a BCP 47 tag): the app passes its panel's language; `strings.language` by
   * default.
   */
  language?: (() => string) | undefined;
  /** The texts the computed ones (`addressErrorText`, ...) are made of, and a skin binds the fixed ones from; English by default. */
  strings?: UiStrings | undefined;
}

/** Which commands the person can press now: one flag per command, named like it. The skin enables its buttons from them. */
export interface WizardCommandAvailability {
  readonly chooseServer: boolean;
  readonly chooseOwnAi: boolean;
  readonly chooseDemo: boolean;
  readonly close: boolean;
  readonly cancel: boolean;
  readonly back: boolean;
  readonly submitServer: boolean;
  readonly changeServer: boolean;
  readonly retry: boolean;
  readonly newCode: boolean;
  readonly usePassword: boolean;
  readonly backToCode: boolean;
  readonly signInWithPassword: boolean;
  readonly openPairingPage: boolean;
  readonly copyCode: boolean;
  readonly accept: boolean;
  readonly serverModeInstead: boolean;
  readonly selectPreset: boolean;
  readonly selectFound: boolean;
  readonly useEndpoint: boolean;
  readonly confirmPlainHttp: boolean;
  readonly submitKey: boolean;
  readonly enterKey: boolean;
  readonly showHelp: boolean;
  readonly continue: boolean;
  readonly connectOrganisation: boolean;
  readonly changeEndpoint: boolean;
  readonly signOut: boolean;
  readonly confirmSignOut: boolean;
}

const DEFAULT_RETRY_AFTER_MS = 60_000;
const TICK_MS = 1000;

/** The problems that make an endpoint unusable, the one to show first first. */
const BLOCKING: readonly EndpointProblem[] = [
  EndpointProblem.KeyRejected, EndpointProblem.OriginRefused, EndpointProblem.CertificateNotTrusted, EndpointProblem.Unreachable,
  EndpointProblem.PlainHttpRefused, EndpointProblem.RateLimited, EndpointProblem.ModelNotFound, EndpointProblem.NotCompatible,
];

const BUSY: ReadonlySet<WizardStep> = new Set([
  WizardStep.BeforeChoice, WizardStep.AppPrecondition, WizardStep.Checking, WizardStep.ServerAccepted, WizardStep.PairStarting,
  WizardStep.Approved, WizardStep.Redeeming, WizardStep.OwnSearching, WizardStep.BeforeCheck, WizardStep.OwnChecking,
  WizardStep.OwnDone, WizardStep.AfterConnect,
]);

const CANCELLABLE: ReadonlySet<WizardStep> = new Set([
  WizardStep.AppPrecondition, WizardStep.Checking, WizardStep.PairStarting, WizardStep.PairCode, WizardStep.Redeeming,
  WizardStep.Approved, WizardStep.OwnSearching, WizardStep.BeforeCheck, WizardStep.OwnChecking, WizardStep.SignOut,
]);

const CHANGE_SERVER: ReadonlySet<WizardStep> = new Set([
  WizardStep.Unreachable, WizardStep.CertificateNotTrusted, WizardStep.NotFadenstack, WizardStep.StartFailed, WizardStep.ServerTooOld,
  WizardStep.PairCode, WizardStep.Denied, WizardStep.Expired, WizardStep.PairFailed, WizardStep.NoAccess,
]);

type Steps = "done" | "stopped" | "stale";

const sameText = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();
/** An address without its query, fragment or closing slash, for comparing a typed address with the policy's. */
const placeOfUrl = (url: URL): string => `${url.origin}${url.pathname}`.replace(/\/+$/, "").toLowerCase();
const isThenable = <T>(value: T | Promise<T>): value is Promise<T> => typeof (value as { then?: unknown } | null)?.then === "function";
/** An aborted or timed out request: the same as no answer. */
const isNoAnswer = (e: unknown): boolean => e instanceof FadenstackUnreachableError || isAbortError(e) || (e instanceof Error && e.name === "TimeoutError");

/**
 * The connection wizard: the skins draw `step` and call the commands; the app gives the stores, its own steps and its
 * declarations (`WizardOptions`), calls `start()`, and on `onCompleted` builds the agent from `result`.
 *
 * No secret stays here (ASVS 5.0 V13): a key goes straight to the `EndpointKeyStore` and only `keySet` remains; a password
 * is a command parameter from the skin's secure input, passed once to the login call; the pairing code stays inside the SDK
 * (it is in the pairing keeper only while the panel may close, `WizardOptions.pairingKeeper`). A newer action aborts every
 * older one (each has its own `AbortController`), and a stale answer changes nothing.
 *
 * The commands are methods; `can` says which are available now. A command pressed when it is not available does nothing.
 */
export class ConnectionWizardViewModel extends Observable {
  readonly #options: WizardOptions;
  readonly #policy: MachinePolicy;
  readonly #entry: WizardEntry;
  readonly #store: ConnectionStore;
  readonly #server: ServerSignIn | undefined;
  readonly #checker: EndpointChecker;
  readonly #keys: EndpointKeyStore | undefined;
  readonly #clock: WizardClock;
  readonly #clipboard: Clipboard | undefined;
  readonly #links: LinkOpener | undefined;
  readonly #language: () => string;
  readonly #strings: UiStrings;
  readonly #completed = new Set<(outcome: WizardOutcome) => void>();

  #run: AbortController | undefined;
  #stopTimer: (() => void) | undefined;
  #stopRetryTimer: (() => void) | undefined;
  #ticket: PairingTicket | undefined;
  #pending: ModelEndpoint | undefined;
  #keyProvider: TokenProvider | undefined;
  #modelChosen = false;
  #started = false;
  #passwordBusy = false;
  /** The keeper holds (or is being given) this wizard's pairing. */
  #kept = false;
  /** The keeper's calls one after the other, so a forget never overtakes the keep before it. */
  #keeperQueue: Promise<void> = Promise.resolve();

  #step: WizardStep = WizardStep.Choose;
  #outcome: WizardOutcome = WizardOutcome.None;
  #result: ConnectionResult | undefined;
  #appStep: WizardStepHandler | undefined;
  #appStepRefused = false;
  #storeFailed = false;
  #signInEnded = false;
  #serverAddressText = "";
  #addressError: AddressProblem = AddressProblem.None;
  #serverUrl: URL | undefined;
  #userCode: string | undefined;
  #pairingPage: URL | undefined;
  #timeLeftMs = 0;
  #isRetrying = false;
  #startFailure: StartFailure | undefined;
  #retryAt: number | undefined;
  #person: SignedInUser | undefined;
  #agents: readonly AgentSignIn[] = [];
  #email = "";
  #passwordFailure: PasswordFailure | undefined;
  #accepted = false;
  #searchConsent = false;
  #found: readonly LocalEndpoint[] = [];
  #selectedPreset: EndpointPreset | undefined;
  #endpointAddressText = "";
  #needsKey = false;
  #keySet = false;
  #problem: EndpointProblem | undefined;
  #report: EndpointReport | undefined;
  #models: readonly string[] = [];
  #selectedModel: string | undefined;
  #deleteLocalChats = false;

  /** The presets the policy allows. */
  readonly presets: readonly EndpointPreset[];
  /** Which commands are available now. */
  readonly can: WizardCommandAvailability;

  /**
   * @param options What the app declares and what the wizard runs with.
   * @param store Where the app keeps the connection.
   * @param services Path A's sign-in (needed when the server path is offered), the key store (needed when own AI is offered),
   *   and the rest, which have defaults.
   * @throws TypeError A path is offered without what it needs (`services.server`, `services.keys`).
   */
  constructor(options: WizardOptions, store: ConnectionStore, services: WizardServices = {}) {
    super();
    if (!options) throw new TypeError("options are needed.");
    if (!store) throw new TypeError("store is needed.");
    if ((options.offersServer ?? true) && !services.server) throw new TypeError("The server path needs its sign-in (services.server: createServerSignIn).");
    if ((options.offersOwnAi ?? true) && !services.keys) throw new TypeError("The own-AI path needs a key store (services.keys).");
    this.#options = options;
    this.#policy = options.policy ?? MachinePolicy.none;
    this.#entry = options.entry ?? WizardEntry.FirstRun;
    this.#store = store;
    this.#server = services.server;
    this.#keys = services.keys;
    this.#checker = services.checker ?? createEndpointChecker(options.checkOptions);
    this.#clock = services.clock ?? createSystemClock();
    this.#clipboard = services.clipboard;
    this.#links = services.links;
    this.#strings = services.strings ?? englishStrings;
    this.#language = services.language ?? (() => this.#strings.language);

    const policy = this.#policy;
    this.presets = Object.freeze(EndpointPreset.all.filter((p) => p.baseUrl === undefined || policy.allowsEndpoint(p.baseUrl)));
    if (policy.server) this.#serverAddressText = policy.server.href;
    this.can = this.#availability();
  }

  /** The wizard is over (`WizardStep.Finished`): how, in `outcome`. Returns the unsubscribe. */
  onCompleted(listener: (outcome: WizardOutcome) => void): () => void {
    this.#completed.add(listener);
    return () => {
      this.#completed.delete(listener);
    };
  }

  // ---- State ----

  get step(): WizardStep {
    return this.#step;
  }

  get outcome(): WizardOutcome {
    return this.#outcome;
  }

  /** The connection, once made (saved before `onCompleted`); keys and tokens are never in it. */
  get result(): ConnectionResult | undefined {
    return this.#result;
  }

  /** A step is running: the skin shows progress and offers Cancel. */
  get isBusy(): boolean {
    return BUSY.has(this.#step) || this.#passwordBusy;
  }

  /** The app's step that runs now (a skin may draw it), or undefined. */
  get appStep(): WizardStepHandler | undefined {
    return this.#appStep;
  }

  /** The app's last step stopped the flow (a permission refused). */
  get appStepRefused(): boolean {
    return this.#appStepRefused;
  }

  /**
   * The app could not keep what the wizard handed it (its settings could not be written): the step that needed it is shown
   * again, to try once more. Cleared when the next action starts.
   */
  get storeFailed(): boolean {
    return this.#storeFailed;
  }

  /** The "your sign-in ended" banner (`WizardEntry.ReSignIn`). */
  get signInEnded(): boolean {
    return this.#signInEnded;
  }

  get canChooseServer(): boolean {
    return this.#options.offersServer ?? true;
  }

  /** Own AI is offered and the policy allows it (`standalone`). */
  get canChooseOwnAi(): boolean {
    return (this.#options.offersOwnAi ?? true) && this.#policy.standalone === PolicyAccess.Allowed;
  }

  get canChooseDemo(): boolean {
    return (this.#options.offersDemo ?? false) && this.#policy.server === undefined;
  }

  /** The machine policy names the server: the address cannot be changed. */
  get serverLocked(): boolean {
    return this.#policy.server !== undefined;
  }

  /** The connection the app has now (Settings). */
  get current(): ConnectionResult | undefined {
    return this.#options.current;
  }

  // Path A.

  get serverAddressText(): string {
    return this.#serverAddressText;
  }

  set serverAddressText(value: string) {
    if (this.serverLocked || value === this.#serverAddressText) return;
    this.#serverAddressText = value ?? "";
    this.#addressError = AddressProblem.None;
    this.notify();
  }

  get addressError(): AddressProblem {
    return this.#addressError;
  }

  /** The server being connected (the address as kept: no query, no fragment). */
  get serverUrl(): URL | undefined {
    return this.#serverUrl;
  }

  /** The code to show (`WizardStep.PairCode`). Show it, never log it. */
  get userCode(): string | undefined {
    return this.#userCode;
  }

  /** The console page with the code filled in. */
  get pairingPage(): URL | undefined {
    return this.#pairingPage;
  }

  /** How long the code is still valid, in ms (whole seconds); ticks each second. */
  get timeLeftMs(): number {
    return this.#timeLeftMs;
  }

  /** The server could not be reached for a moment; the wait goes on by itself (the "retrying" banner). */
  get isRetrying(): boolean {
    return this.#isRetrying;
  }

  get startFailure(): StartFailure | undefined {
    return this.#startFailure;
  }

  /** After a rate limit: when a new try is allowed, in ms since the epoch. */
  get retryAt(): number | undefined {
    return this.#retryAt;
  }

  /** Who signed in ("Signed in as ..."). */
  get person(): SignedInUser | undefined {
    return this.#person;
  }

  /** Each agent's sign-in. */
  get agents(): readonly AgentSignIn[] {
    return this.#agents;
  }

  get passwordFallback(): boolean {
    return this.#options.passwordFallback ?? false;
  }

  /** The e-mail for the password sign-in. The password itself is never a property. */
  get email(): string {
    return this.#email;
  }

  set email(value: string) {
    this.#email = value ?? "";
    this.notify();
  }

  get passwordFailure(): PasswordFailure | undefined {
    return this.#passwordFailure;
  }

  // Path B.

  /** The consent box; starts unticked. */
  get accepted(): boolean {
    return this.#accepted;
  }

  set accepted(value: boolean) {
    if (value === this.#accepted) return;
    this.#accepted = value;
    this.notify();
  }

  /** Consent to search this computer for model servers; without it only a preset or an address. */
  get searchConsent(): boolean {
    return this.#searchConsent;
  }

  set searchConsent(value: boolean) {
    if (value === this.#searchConsent) return;
    this.#searchConsent = value;
    this.notify();
  }

  get canSearchThisComputer(): boolean {
    return this.#options.canSearchThisComputer ?? true;
  }

  /** The model servers the search found here (what the policy allows). */
  get found(): readonly LocalEndpoint[] {
    return this.#found;
  }

  get selectedPreset(): EndpointPreset | undefined {
    return this.#selectedPreset;
  }

  get endpointAddressText(): string {
    return this.#endpointAddressText;
  }

  set endpointAddressText(value: string) {
    if (value === this.#endpointAddressText) return;
    this.#endpointAddressText = value ?? "";
    this.#addressError = AddressProblem.None;
    this.notify();
  }

  /** The endpoint needs a key (from the preset; the person may set it for an address of their own). */
  get needsKey(): boolean {
    return this.#needsKey;
  }

  set needsKey(value: boolean) {
    if (value === this.#needsKey) return;
    this.#needsKey = value;
    this.notify();
  }

  /** A key is in the key store for this endpoint. The key itself never is a property. */
  get keySet(): boolean {
    return this.#keySet;
  }

  /** Why the endpoint is unusable (`WizardStep.OwnFailed`). */
  get problem(): EndpointProblem | undefined {
    return this.#problem;
  }

  /** The check's report. */
  get report(): EndpointReport | undefined {
    return this.#report;
  }

  get models(): readonly string[] {
    return this.#models;
  }

  get selectedModel(): string | undefined {
    return this.#selectedModel;
  }

  set selectedModel(value: string | undefined) {
    if (value === this.#selectedModel) return;
    this.#selectedModel = value;
    this.notify();
  }

  // Settings.

  /** Sign-out also deletes the chats kept on this computer; starts unticked. */
  get deleteLocalChats(): boolean {
    return this.#deleteLocalChats;
  }

  set deleteLocalChats(value: boolean) {
    if (value === this.#deleteLocalChats) return;
    this.#deleteLocalChats = value;
    this.notify();
  }

  // ---- Texts (UiStrings, five languages) ----

  /** The texts; a skin binds the fixed ones (`strings.wizardServerTitle`) and the computed ones below. */
  get strings(): UiStrings {
    return this.#strings;
  }

  /** Why the typed address was not taken, for the step showing it; undefined when it was. */
  get addressErrorText(): string | undefined {
    const t = this.#strings;
    switch (this.#addressError) {
      case AddressProblem.None:
        return undefined;
      case AddressProblem.Invalid:
        return this.#step === WizardStep.ServerAddress ? t.wizardServerAddressInvalid : t.wizardEndpointAddressInvalid;
      case AddressProblem.HttpsRequired:
        return this.#step === WizardStep.ServerAddress ? t.wizardServerHttpsRequired : t.wizardEndpointHttpsRequired;
      case AddressProblem.NotAllowed:
        return t.wizardAddressNotAllowed;
      case AddressProblem.PlainHttpForbidden:
        return t.wizardAddressPlainHttpForbidden;
      default:
        return t.wizardAddressKeyNeedsHttps;
    }
  }

  get startFailureText(): string | undefined {
    return this.#startFailure === undefined ? undefined : this.#strings.wizardStartFailure[this.#startFailure];
  }

  get passwordFailureText(): string | undefined {
    return this.#passwordFailure === undefined ? undefined : this.#strings.wizardPasswordFailure[this.#passwordFailure];
  }

  /** Why the endpoint is unusable, in plain words. */
  get problemText(): string | undefined {
    return this.#problem === undefined ? undefined : this.#strings.wizardProblem[this.#problem];
  }

  /** "Waiting for your approval... The code expires in 9:41." (or the retrying line) while the code shows. */
  get waitingText(): string | undefined {
    if (this.#step !== WizardStep.PairCode) return undefined;
    return this.#isRetrying ? this.#strings.wizardWaitingRetry(this.#timeLeftMs) : this.#strings.wizardWaiting(this.#timeLeftMs);
  }

  /** "Signed in as Ana." for the moment after the approval. */
  get signedInText(): string {
    const person = this.#person;
    if (!person) return this.#strings.wizardSignedIn;
    return this.#strings.wizardSignedInAs(person.displayName?.trim() ? person.displayName : person.email);
  }

  /**
   * What the check found, in plain words (F15 step 4): that it works, what limits it (chat only, the context, the key
   * unencrypted on this computer, ...), and whether the connection watermarks text.
   */
  get resultLines(): readonly string[] {
    const report = this.#report;
    if (!report || !report.usable) return [];
    const t = this.#strings;
    const lines = [t.wizardOwnWorks];
    const problems = new Set(report.problems.filter((p) => !BLOCKING.includes(p) && p !== EndpointProblem.Failed));
    for (const problem of problems) lines.push(t.wizardProblem[problem]);
    lines.push(t.wizardWatermark[report.watermark.status]);
    if (report.watermark.confirmed === true) lines.push(t.wizardWatermarkConfirmed);
    return lines;
  }

  /** Settings' line for the connection the app has now. */
  get connectedText(): string | undefined {
    const current = this.#options.current;
    if (current?.mode === ConnectionMode.Server && current.server) return this.#strings.wizardConnectedServer(current.server.href);
    if (current?.mode === ConnectionMode.Endpoint && current.endpoint) {
      return this.#strings.wizardConnectedEndpoint(new URL(String(current.endpoint.baseUrl)).href);
    }
    return undefined;
  }

  // ---- Entry ----

  /** Starts the wizard as `WizardOptions.entry` says. Once per view model. */
  start(): Promise<void> {
    if (this.#started) throw new Error("A wizard runs once; make a new one.");
    this.#started = true;
    switch (this.#entry) {
      case WizardEntry.Settings:
        this.#go(WizardStep.Settings);
        return Promise.resolve();
      case WizardEntry.ServerKnown:
      case WizardEntry.ReSignIn: {
        this.#signInEnded = this.#entry === WizardEntry.ReSignIn;
        const known = this.#policy.server ?? this.#options.server;
        if (!known || !this.canChooseServer) {
          this.#openServerAddress();
          return Promise.resolve();
        }
        this.#serverUrl = known;
        this.#serverAddressText = known.href;
        this.notify();
        return this.#startPairing(true);
      }
      default:
        return this.#firstRun();
    }
  }

  async #firstRun(): Promise<void> {
    const run = this.#newRun();
    const steps = await this.#runSteps(WizardPoint.BeforeChoice, { point: WizardPoint.BeforeChoice }, WizardStep.BeforeChoice, run);
    if (steps === "stale") return;
    if (steps === "stopped") {
      this.#finish(WizardOutcome.Closed);
      return;
    }
    const named = this.#policy.server;
    if (named && this.canChooseServer) {
      this.#serverUrl = named; // the policy's server: path A, locked
      await this.#startPairing(true);
      return;
    }
    if (this.canChooseServer && this.#canResume) {
      // A pairing kept while the panel was closed: back to its code (I15 §2).
      const kept = await this.#peekKept(undefined);
      if (!this.#isCurrent(run)) return;
      if (kept) {
        this.#serverUrl = kept.server;
        this.#serverAddressText = kept.server.href;
        this.notify();
        await this.#startPairing(kept);
        return;
      }
    }
    this.#showChoice();
  }

  /** The choice, or straight on when only one path is offered and allowed. */
  #showChoice(): void {
    const paths = (this.canChooseServer ? 1 : 0) + (this.canChooseOwnAi ? 1 : 0);
    if (this.canChooseDemo || paths !== 1) this.#go(WizardStep.Choose);
    else if (this.canChooseServer) this.#openServerAddress();
    else this.#openOwnAccept();
  }

  /** Back to where the wizard began: Settings, or the choice. */
  #backToStart(): void {
    this.#cancelRun();
    this.#result = undefined;
    if (this.#entry === WizardEntry.Settings) this.#go(WizardStep.Settings);
    else this.#showChoice();
  }

  // ---- Commands: the choice, closing, cancelling, going back ----

  chooseServer(): void {
    if (this.can.chooseServer) this.#openServerAddress();
  }

  chooseOwnAi(): void {
    if (this.can.chooseOwnAi) this.#openOwnAccept();
  }

  chooseDemo(): void {
    if (this.can.chooseDemo) this.#finish(WizardOutcome.Demo);
  }

  close(): void {
    if (this.can.close) this.#finish(WizardOutcome.Closed);
  }

  /** Stops what runs, one step back: a server step to the address, an endpoint step to the pick. */
  cancel(): void {
    if (!this.can.cancel) return;
    switch (this.#step) {
      case WizardStep.AppPrecondition:
      case WizardStep.Checking:
      case WizardStep.PairStarting:
      case WizardStep.PairCode:
      case WizardStep.Redeeming:
      case WizardStep.Approved:
        this.#cancelRun();
        this.#clearPairing();
        this.#openServerAddress();
        break;
      case WizardStep.Password:
        this.#cancelRun();
        this.#setPasswordBusy(false);
        break;
      case WizardStep.OwnSearching:
      case WizardStep.BeforeCheck:
      case WizardStep.OwnChecking:
        this.#openPick();
        break;
      case WizardStep.SignOut:
        this.#go(WizardStep.Settings);
        break;
    }
  }

  back(): void {
    if (!this.can.back) return;
    switch (this.#step) {
      case WizardStep.ServerAddress:
      case WizardStep.OwnAccept:
        this.#backToStart();
        break;
      case WizardStep.OwnPick:
        this.#openOwnAccept();
        break;
      case WizardStep.OwnPlainHttp:
      case WizardStep.OwnKey:
      case WizardStep.OwnResult:
      case WizardStep.OwnFailed:
      case WizardStep.OwnHelp:
        this.#openPick();
        break;
      case WizardStep.OwnModel:
        this.#go(WizardStep.OwnResult);
        break;
    }
  }

  // ---- Path A ----

  #openServerAddress(): void {
    this.#cancelRun();
    this.#addressError = AddressProblem.None;
    this.#appStepRefused = false;
    this.#go(WizardStep.ServerAddress);
  }

  /** Submits the typed address: the app's step, the health check, the pairing. */
  async submitServer(): Promise<void> {
    if (!this.can.submitServer) return;
    const { server, problem } = this.parseServer(this.#serverAddressText);
    if (!server) {
      this.#addressError = problem;
      this.notify();
      return;
    }
    this.#addressError = AddressProblem.None;
    this.#appStepRefused = false;
    this.#serverUrl = server;
    const run = this.#newRun();
    const steps = await this.#runSteps(WizardPoint.BeforeServerCheck, { point: WizardPoint.BeforeServerCheck, server }, WizardStep.AppPrecondition, run);
    if (steps === "stale") return;
    if (steps === "stopped") {
      this.#go(WizardStep.ServerAddress); // the app's step refused (a permission)
      return;
    }
    await this.#checkServer(run);
  }

  /**
   * The address rule (I15 §2): the scheme, host, port and path are kept, the query and fragment dropped; no scheme means
   * https; https, or http to this machine, or the http server a machine policy names; no user name in it.
   */
  parseServer(text: string): { server: URL | undefined; problem: AddressProblem } {
    let trimmed = (text ?? "").trim();
    if (trimmed.length === 0) return { server: undefined, problem: AddressProblem.Invalid };
    if (!trimmed.includes("://")) trimmed = `https://${trimmed}`;
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return { server: undefined, problem: AddressProblem.Invalid };
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || !url.hostname) {
      return { server: undefined, problem: AddressProblem.Invalid };
    }
    url.search = "";
    url.hash = "";
    if (url.protocol === "http:" && hostScope(url.hostname) !== "loopback" && !this.#isPolicyServer(url)) {
      return { server: undefined, problem: AddressProblem.HttpsRequired };
    }
    return { server: url, problem: AddressProblem.None };
  }

  #isPolicyServer(server: URL): boolean {
    const named = this.#policy.server;
    return named !== undefined && placeOfUrl(named) === placeOfUrl(server);
  }

  async #checkServer(run: AbortController): Promise<void> {
    this.#go(WizardStep.Checking);
    try {
      await this.#server!.check(this.#serverUrl!, run.signal);
    } catch (e) {
      if (!this.#isCurrent(run)) return;
      if (e instanceof ServerCertificateError) {
        this.#go(WizardStep.CertificateNotTrusted);
      } else if (isNoAnswer(e)) {
        this.#go(WizardStep.Unreachable);
      } else if (e instanceof FadenstackHttpsRequiredError) {
        this.#addressError = AddressProblem.HttpsRequired;
        this.#go(WizardStep.ServerAddress);
      } else {
        this.#go(WizardStep.NotFadenstack);
      }
      return;
    }
    if (!this.#isCurrent(run)) return;
    this.#go(WizardStep.ServerAccepted);
    if (!(await this.#keep((signal) => this.#store.saveServer(this.#serverUrl!, signal), run))) {
      if (this.#isCurrent(run)) this.#go(WizardStep.ServerAddress);
      return;
    }
    if (this.#options.restartsOnNewServer) {
      this.#finish(WizardOutcome.RestartOnServer); // the app starts again on it, as ServerKnown
      return;
    }
    await this.#startPairing();
  }

  /**
   * Asks for a pairing code and waits for the approval. With `resume`, a pairing the keeper holds comes first: `true` looks
   * it up for the known server, a `SavedPairing` is one already read (the first run).
   */
  async #startPairing(resume: boolean | KeptPairing = false): Promise<void> {
    const run = this.#newRun();
    this.#clearPairing();
    this.#setStartFailure(undefined, undefined);
    this.#go(WizardStep.PairStarting);
    let ticket: PairingTicket | undefined;
    let resumed = false;
    if (resume && this.#canResume) {
      const kept = resume === true ? await this.#peekKept(this.#serverUrl) : resume;
      if (!this.#isCurrent(run)) return;
      if (kept) {
        ticket = this.#resumeTicket(kept);
        resumed = ticket !== undefined;
      }
    }
    if (!ticket) {
      try {
        ticket = await this.#server!.start(this.#serverUrl!, run.signal);
      } catch (e) {
        if (this.#isCurrent(run)) this.#startFailed(e);
        return;
      }
      if (!this.#isCurrent(run)) return;
    }
    this.#ticket = ticket;
    this.#userCode = ticket.userCode;
    this.#pairingPage = ticket.verificationUriComplete;
    this.#updateTimeLeft();
    this.#go(WizardStep.PairCode);
    this.#scheduleTick(run);
    if (!resumed) this.#keepPairing(ticket);
    await this.#waitForApproval(ticket, run);
  }

  #startFailed(e: unknown): void {
    if (e instanceof FadenstackPairingUnsupportedError) {
      this.#go(WizardStep.ServerTooOld);
      return;
    }
    let failure: StartFailure;
    if (e instanceof FadenstackRateLimitedError) failure = StartFailure.RateLimited;
    else if (e instanceof FadenstackPairingPageElsewhereError) failure = StartFailure.PageElsewhere;
    else if (e instanceof ServerCertificateError) failure = StartFailure.CertificateNotTrusted;
    else if (isNoAnswer(e)) failure = StartFailure.Unreachable;
    else failure = StartFailure.ServerError;
    let retryAt: number | undefined;
    if (e instanceof FadenstackRateLimitedError) {
      // The rate limit happens only here: the poll's slow_down is handled silently in the SDK.
      const wait = e.retryAfterMs !== undefined && e.retryAfterMs > 0 ? e.retryAfterMs : DEFAULT_RETRY_AFTER_MS;
      retryAt = this.#clock.now() + wait;
      this.#stopRetryTimer?.();
      this.#stopRetryTimer = this.#clock.after(wait, () => this.notify()); // Retry becomes available: the skin reads `can` again
    }
    this.#setStartFailure(failure, retryAt);
    this.#go(WizardStep.StartFailed);
  }

  #setStartFailure(failure: StartFailure | undefined, retryAt: number | undefined): void {
    this.#startFailure = failure;
    this.#retryAt = retryAt;
    this.notify();
  }

  async #waitForApproval(ticket: PairingTicket, run: AbortController): Promise<void> {
    let approval: PairingApproval;
    try {
      approval = await this.#server!.wait(ticket, (retrying) => {
        if (this.#isCurrent(run)) {
          this.#isRetrying = retrying;
          this.notify();
        }
      }, run.signal);
    } catch (e) {
      if (!this.#isCurrent(run)) return;
      this.#stopCountdown();
      this.#isRetrying = false;
      this.#forget(); // the wait is over, one way or another: the pairing is not kept
      this.#go(e instanceof FadenstackPairingDeniedError ? WizardStep.Denied
        : e instanceof FadenstackPairingExpiredError ? WizardStep.Expired : WizardStep.PairFailed);
      return;
    }
    if (!this.#isCurrent(run)) return;
    this.#stopCountdown();
    this.#isRetrying = false;
    this.#forget();
    this.#person = approval.person;
    this.#go(WizardStep.Approved);
    await this.#redeem(ticket, approval, run);
  }

  /** Collects the pairing's other agents (one approval for all, sdk/47), then signed in or no access. */
  async #redeem(ticket: PairingTicket, approval: PairingApproval, run: AbortController): Promise<void> {
    this.#go(WizardStep.Redeeming);
    const agents = [...approval.agents];
    for (const agent of ticket.agents.filter((a) => !agents.some((s) => sameText(s.agent, a)))) {
      if (run.signal.aborted) return; // cancelled: no more requests for the agents left
      try {
        agents.push(await this.#server!.redeem(ticket, agent, run.signal));
      } catch {
        if (this.#isCurrent(run)) this.#go(WizardStep.PairFailed);
        return;
      }
    }
    if (this.#isCurrent(run)) this.#signedInOrNoAccess(approval.person, agents, run);
  }

  #signedInOrNoAccess(person: SignedInUser | undefined, agents: readonly AgentSignIn[], run: AbortController): void {
    this.#person = person;
    this.#agents = agents;
    const main = this.#options.agents?.[0] ?? agents[0]?.agent;
    const named = this.#options.requiredAgents ?? [];
    const required = named.length > 0 ? named : main === undefined ? [] : [main];
    if (required.some((r) => !agents.some((a) => a.access === AgentAccess.Approved && sameText(a.agent, r)))) {
      this.#go(WizardStep.NoAccess);
      return;
    }
    this.#result = { mode: ConnectionMode.Server, server: this.#serverUrl, person, agents };
    this.#go(WizardStep.SignedIn);
    // "Signed in as ..." for a moment, then the app's steps and the result.
    this.#stopTimer = this.#clock.after(this.#options.signedInPauseMs ?? 1500, () => {
      if (this.#isCurrent(run) && this.#step === WizardStep.SignedIn) void this.#afterConnect(run);
    });
  }

  /** Asks for a new code after a denial or an expiry. */
  newCode(): Promise<void> {
    return this.can.newCode ? this.#startPairing() : Promise.resolve();
  }

  /** Back from the password sign-in to a pairing code. */
  backToCode(): Promise<void> {
    return this.can.backToCode ? this.#startPairing() : Promise.resolve();
  }

  usePassword(): void {
    if (!this.can.usePassword) return;
    this.#cancelRun();
    this.#clearPairing();
    this.#passwordFailure = undefined;
    this.#go(WizardStep.Password);
  }

  /** The password sign-in; the parameter is the password from the skin's secure input, passed once and kept nowhere. */
  async signInWithPassword(password: string | null | undefined): Promise<void> {
    if (!this.can.signInWithPassword) return;
    if (!this.#email.trim() || !password) return;
    const run = this.#newRun();
    this.#setPasswordBusy(true);
    let approval: PairingApproval;
    try {
      approval = await this.#server!.signInWithPassword(this.#serverUrl!, this.#email.trim(), password, run.signal);
    } catch (e) {
      if (!this.#isCurrent(run)) return;
      this.#setPasswordBusy(false);
      this.#passwordFailure = passwordFailureOf(e);
      this.#go(WizardStep.PasswordError);
      return;
    }
    if (!this.#isCurrent(run)) return;
    this.#setPasswordBusy(false);
    this.#signedInOrNoAccess(approval.person, approval.agents, run);
  }

  #setPasswordBusy(busy: boolean): void {
    this.#passwordBusy = busy;
    this.notify();
  }

  changeServer(): void {
    if (!this.can.changeServer) return;
    this.#cancelRun();
    this.#clearPairing();
    this.#openServerAddress();
  }

  /** Opens the pairing page in the browser. */
  openPairingPage(): void {
    if (this.can.openPairingPage) this.#links?.tryOpen(this.#pairingPage!);
  }

  /** Puts the code on the clipboard. */
  copyCode(): void {
    if (this.can.copyCode) void this.#clipboard?.setText(this.#userCode!);
  }

  #clearPairing(): void {
    this.#stopCountdown();
    this.#ticket = undefined;
    this.#userCode = undefined;
    this.#pairingPage = undefined;
    this.#timeLeftMs = 0;
    this.#isRetrying = false;
    this.#forget();
    this.notify();
  }

  #scheduleTick(run: AbortController): void {
    this.#stopCountdown();
    this.#stopTimer = this.#clock.after(TICK_MS, () => {
      if (!this.#isCurrent(run) || this.#step !== WizardStep.PairCode) return;
      this.#updateTimeLeft();
      if (this.#timeLeftMs <= 0) {
        this.#cancelRun(); // the code expired here: the wait stops
        this.#clearPairing();
        this.#go(WizardStep.Expired);
        return;
      }
      this.#scheduleTick(run);
    });
  }

  #updateTimeLeft(): void {
    const left = this.#ticket ? this.#ticket.expiresAt - this.#clock.now() : 0;
    this.#timeLeftMs = left <= 0 ? 0 : Math.ceil(left / 1000) * 1000;
    this.notify();
  }

  // ---- The pairing across a closed panel (TS only, I15 §2) ----

  get #canResume(): boolean {
    return this.#options.pairingKeeper !== undefined && this.#server?.export !== undefined && this.#server.resume !== undefined;
  }

  /** The kept pairing for `only` (any server when undefined), or undefined; one that cannot be used (expired, another server, unreadable) is forgotten. */
  async #peekKept(only: URL | undefined): Promise<KeptPairing | undefined> {
    const keeper = this.#options.pairingKeeper;
    if (!keeper) return undefined;
    let saved: SavedPairing | undefined;
    try {
      saved = await keeper.restore();
    } catch {
      return undefined; // nothing kept that can be read
    }
    if (saved === undefined || saved === null) return undefined;
    const server = typeof saved === "object" && typeof saved.server === "string" ? this.parseServer(saved.server).server : undefined;
    const named = this.#policy.server;
    const usable = server !== undefined && Number.isFinite(saved.expiresAt) && saved.expiresAt > this.#clock.now()
      && typeof saved.pairing === "object" && saved.pairing !== null
      && (only === undefined || placeOfUrl(only) === placeOfUrl(server))
      && (named === undefined || placeOfUrl(named) === placeOfUrl(server));
    if (!usable) {
      this.#queueKeeper(() => keeper.forget()); // expired, or not this server's: a new start
      return undefined;
    }
    return { server, saved };
  }

  #resumeTicket(kept: KeptPairing): PairingTicket | undefined {
    try {
      const ticket = this.#server!.resume!(kept.server, kept.saved.pairing);
      this.#kept = true;
      return ticket;
    } catch {
      this.#queueKeeper(() => this.#options.pairingKeeper!.forget());
      return undefined;
    }
  }

  /** Keeps the pairing when its code shows (the panel may close while the person approves in the console). */
  #keepPairing(ticket: PairingTicket): void {
    const keeper = this.#options.pairingKeeper;
    if (!keeper || !this.#canResume) return;
    let pairing;
    try {
      pairing = this.#server!.export!(ticket);
    } catch {
      return;
    }
    if (!pairing) return;
    this.#kept = true;
    const saved: SavedPairing = { server: this.#serverUrl!.href, expiresAt: ticket.expiresAt, pairing };
    this.#queueKeeper(() => keeper.keep(saved));
  }

  /** Forgets the pairing when it ends (approved, denied, expired, failed) or is cancelled; a closed panel is none of these. */
  #forget(): void {
    const keeper = this.#options.pairingKeeper;
    if (!keeper || !this.#kept) return;
    this.#kept = false;
    this.#queueKeeper(() => keeper.forget());
  }

  /** The keeper's calls go one after the other and never fail the flow: a pairing that is not kept still works in this panel. */
  #queueKeeper(call: () => void | Promise<void>): void {
    this.#keeperQueue = this.#keeperQueue.then(call).catch(() => undefined);
  }

  // ---- Path B ----

  #openOwnAccept(): void {
    this.#cancelRun();
    this.#accepted = false;
    this.#searchConsent = false;
    this.#go(WizardStep.OwnAccept);
  }

  /** The consent box was ticked: the acceptance record is kept, then the local search (with consent), then the pick. */
  async accept(): Promise<void> {
    if (!this.can.accept) return;
    const run = this.#newRun();
    const record = { termsVersion: this.#options.termsVersion ?? "", acceptedAt: this.#clock.now(), language: this.#language(), mode: "standalone" };
    if (!(await this.#keep((signal) => this.#store.saveAcceptance(record, signal), run))) return; // stays at the acceptance: without its record the person has not accepted
    if (this.#searchConsent && this.canSearchThisComputer) {
      this.#go(WizardStep.OwnSearching);
      let found: readonly LocalEndpoint[];
      try {
        found = await this.#checker.findLocal(run.signal);
      } catch {
        found = []; // nothing found is no failure: a preset or an address remains
      }
      if (!this.#isCurrent(run)) return;
      this.#found = found.filter((f) => this.#policy.allowsEndpoint(f.baseUrl));
      this.notify();
    }
    this.#openPick();
  }

  serverModeInstead(): void {
    if (this.can.serverModeInstead) this.#openServerAddress();
  }

  #openPick(): void {
    this.#cancelRun();
    this.#addressError = AddressProblem.None;
    this.#appStepRefused = false;
    this.#go(WizardStep.OwnPick);
  }

  selectPreset(preset: EndpointPreset | null | undefined): void {
    if (!this.can.selectPreset || !preset) return;
    this.#selectedPreset = preset;
    this.endpointAddressText = preset.baseUrl ?? "";
    this.#needsKey = preset.needsKey;
    this.notify();
  }

  selectFound(found: LocalEndpoint | null | undefined): void {
    if (!this.can.selectFound || !found) return;
    this.#selectedPreset = found.preset;
    this.endpointAddressText = found.baseUrl.href;
    this.#needsKey = false;
    this.notify();
  }

  /**
   * Uses the address in the pick. **The app's step before the check (Chrome's host permission) runs inside the gesture that
   * pressed the button:** for an https address, or where `placeOf` answers at once (the default), nothing is awaited before
   * it. Only a `placeOf` that returns a promise, or a key to save, comes first.
   */
  async useEndpoint(): Promise<void> {
    if (!this.can.useEndpoint) return;
    const url = parseEndpoint(this.#endpointAddressText);
    if (!url) return this.#refuse(AddressProblem.Invalid);
    if (!this.#policy.allowsEndpoint(url)) return this.#refuse(AddressProblem.NotAllowed);
    const run = this.#newRun();
    let lan = false;
    if (url.protocol === "http:") {
      let where: EndpointPlace;
      try {
        const asked = this.#checker.placeOf(url, run.signal);
        where = isThenable(asked) ? await asked : asked;
      } catch {
        if (!this.#isCurrent(run)) return;
        where = EndpointPlace.Internet; // where it points cannot be told: plain http is refused
      }
      if (!this.#isCurrent(run)) return;
      const forbidden = this.#policy.plainHttp === PolicyAccess.Forbidden;
      if (where === EndpointPlace.ThisComputer) {
        if (this.#needsKey && forbidden) return this.#refuse(AddressProblem.PlainHttpForbidden); // the policy forbids a key unencrypted, even here
        // otherwise a key may go: the check says "unencrypted on this computer" (owner, 14 Nov)
      } else if (where === EndpointPlace.LocalNetwork) {
        if (forbidden) return this.#refuse(AddressProblem.PlainHttpForbidden);
        if (this.#needsKey) return this.#refuse(AddressProblem.KeyNeedsHttps); // never a key over plain http to the network (D3)
        lan = true;
      } else {
        return this.#refuse(AddressProblem.HttpsRequired);
      }
    }
    this.#pending = {
      baseUrl: url, dialect: this.#selectedPreset?.dialect ?? EndpointDialect.openAiCompatible, allowPlainHttpInLan: lan,
    };
    this.#keyProvider = undefined;
    this.#keySet = false;
    this.#modelChosen = false;
    this.notify();
    if (lan) {
      this.#go(WizardStep.OwnPlainHttp); // the person confirms; no key
      return;
    }
    if (this.#needsKey) {
      this.#go(WizardStep.OwnKey);
      return;
    }
    await this.#runCheck();
  }

  #refuse(problem: AddressProblem): void {
    this.#addressError = problem;
    this.notify();
  }

  /** Plain http to the local network, confirmed: the check, with no key. */
  confirmPlainHttp(): Promise<void> {
    return this.can.confirmPlainHttp ? this.#runCheck() : Promise.resolve();
  }

  /**
   * The key; the parameter is the key from the skin's secure input, handed to the key store at once and kept nowhere.
   * Saving the key is awaited before the app's step runs (the step gets the endpoint with its key provider): this is the one
   * await ahead of the gesture step, and the key store should answer at once.
   */
  async submitKey(key: string | null | undefined): Promise<void> {
    if (!this.can.submitKey) return;
    if (!key?.trim() || !this.#pending) return;
    const run = this.#newRun();
    let provider: TokenProvider | undefined;
    const pending = this.#pending;
    if (!(await this.#keep(async (signal) => { provider = await this.#keys!.save(toUrl(pending.baseUrl), key.trim(), signal); }, run))) {
      return; // the key store failed (storeFailed) or the action is stale: the key step stays
    }
    this.#keyProvider = provider;
    this.#keySet = true;
    this.notify();
    await this.#runCheck();
  }

  enterKey(): void {
    if (!this.can.enterKey) return;
    this.#needsKey = true;
    this.#go(WizardStep.OwnKey);
  }

  showHelp(): void {
    if (this.can.showHelp) this.#go(WizardStep.OwnHelp);
  }

  async #runCheck(): Promise<void> {
    if (!this.#pending) return;
    const run = this.#newRun();
    const endpoint = this.#endpointWithKey();
    this.#appStepRefused = false;
    // Every way into a check passes the app's step first, inside the gesture that pressed "Check" (Chrome's permission): this
    // is called before the first await of the command where it can be.
    const steps = await this.#runSteps(WizardPoint.BeforeEndpointCheck, { point: WizardPoint.BeforeEndpointCheck, endpoint }, WizardStep.BeforeCheck, run);
    if (steps === "stale") return;
    if (steps === "stopped") {
      this.#addressError = AddressProblem.None;
      this.#go(WizardStep.OwnPick);
      return;
    }
    this.#go(WizardStep.OwnChecking);
    let report: EndpointReport;
    try {
      report = await this.#checker.check(endpoint, run.signal);
    } catch {
      if (this.#isCurrent(run)) {
        this.#problem = EndpointProblem.Failed;
        this.#go(WizardStep.OwnFailed);
      }
      return;
    }
    if (!this.#isCurrent(run)) return;
    this.#report = report;
    if (!report.usable) {
      this.#problem = BLOCKING.find((p) => report.problems.includes(p)) ?? EndpointProblem.Failed;
      this.#go(WizardStep.OwnFailed);
      return;
    }
    this.#problem = undefined;
    this.#models = report.models.length > 0 ? [...report.models] : report.model ? [report.model] : [];
    this.#pending = { ...this.#pending, model: report.model };
    this.#selectedModel = report.model;
    this.#go(WizardStep.OwnResult);
  }

  #endpointWithKey(): ModelEndpoint {
    return this.#keyProvider ? { ...this.#pending!, key: this.#keyProvider } : { ...this.#pending! };
  }

  /** From the result, or the model pick: the next step, or the connection. */
  async continue(): Promise<void> {
    if (!this.can.continue) return;
    if (this.#step === WizardStep.OwnResult) {
      if (this.#modelChosen || this.#models.length <= 1) {
        await this.#finishEndpoint();
        return;
      }
      this.#go(WizardStep.OwnModel);
      return;
    }
    if (this.#step !== WizardStep.OwnModel || !this.#selectedModel || !this.#pending) return;
    this.#modelChosen = true;
    if (this.#selectedModel === this.#report?.model) {
      await this.#finishEndpoint();
      return;
    }
    // Another model than the one checked: the check runs again for it (tools and context differ by model).
    this.#pending = { ...this.#pending, model: this.#selectedModel };
    await this.#runCheck();
  }

  async #finishEndpoint(): Promise<void> {
    const run = this.#newRun();
    this.#result = { mode: ConnectionMode.Endpoint, endpoint: this.#endpointWithKey(), report: this.#report, presetId: this.#selectedPreset?.id };
    this.#go(WizardStep.OwnDone);
    await this.#afterConnect(run);
  }

  // ---- Settings ----

  connectOrganisation(): void {
    if (this.can.connectOrganisation) this.#openServerAddress();
  }

  changeEndpoint(): void {
    if (this.can.changeEndpoint) this.#openOwnAccept();
  }

  signOut(): void {
    if (!this.can.signOut) return;
    this.#deleteLocalChats = false;
    this.#go(WizardStep.SignOut);
  }

  async confirmSignOut(): Promise<void> {
    if (!this.can.confirmSignOut) return;
    const run = this.#newRun();
    const current = this.#options.current;
    const endpoint = current?.mode === ConnectionMode.Endpoint ? current.endpoint : undefined;
    const done = await this.#keep(async (signal) => {
      await this.#store.signOut(this.#deleteLocalChats, signal);
      if (endpoint && this.#keys) await this.#keys.remove(toUrl(endpoint.baseUrl), signal);
    }, run);
    if (done) this.#finish(WizardOutcome.SignedOut);
    // Otherwise it stays at the sign-out, with storeFailed: try again, or cancel.
  }

  // ---- Both paths ----

  async #afterConnect(run: AbortController): Promise<void> {
    const result = this.#result!;
    const steps = await this.#runSteps(WizardPoint.AfterConnect,
      { point: WizardPoint.AfterConnect, server: result.server, endpoint: result.endpoint, result }, WizardStep.AfterConnect, run);
    if (steps === "stale") return;
    if (steps === "stopped") {
      this.#backToStart(); // the connection is not used
      return;
    }
    if (!(await this.#keep((signal) => this.#store.save(result, signal), run))) {
      if (this.#isCurrent(run)) {
        this.#backToStart(); // not kept, so not connected (the server's tokens are in the token store already)
        this.#storeFailed = true;
        this.notify();
      }
      return;
    }
    this.#finish(WizardOutcome.Connected);
  }

  /**
   * Runs one of the app's store calls; false when it was cancelled or failed. A failure is the app's (its settings could not
   * be written): `storeFailed` says so, and the wizard never stays on a busy step for it.
   */
  async #keep(call: (signal: AbortSignal) => Promise<void>, run: AbortController): Promise<boolean> {
    let failed = false;
    try {
      await call(run.signal);
    } catch {
      if (run.signal.aborted) return false;
      failed = true;
    }
    if (!this.#isCurrent(run)) return false;
    if (failed) {
      this.#storeFailed = true;
      this.notify();
      return false;
    }
    return true;
  }

  /** Retries what failed: the health check, the pairing, the endpoint check, the password sign-in. */
  async retry(): Promise<void> {
    if (!this.can.retry) return;
    switch (this.#step) {
      case WizardStep.Unreachable:
        await this.#checkServer(this.#newRun());
        break;
      case WizardStep.StartFailed:
      case WizardStep.PairFailed:
        await this.#startPairing();
        break;
      case WizardStep.OwnFailed:
      case WizardStep.OwnHelp:
        await this.#runCheck();
        break;
      case WizardStep.PasswordError:
        this.#passwordFailure = undefined;
        this.#go(WizardStep.Password);
        break;
    }
  }

  // ---- Plumbing ----

  /** Runs the app's steps at `point`, showing `showing` while one runs. The first step is called before any await. */
  async #runSteps(point: WizardPoint, context: WizardStepContext, showing: WizardStep, run: AbortController): Promise<Steps> {
    for (const step of (this.#options.steps ?? []).filter((s) => s.point === point)) {
      this.#go(showing);
      this.#appStep = step;
      this.notify();
      let ok: boolean;
      try {
        ok = await step.run(context, run.signal);
      } catch {
        ok = false; // a step that fails stops the flow, as one that says no
      }
      if (!this.#isCurrent(run)) return "stale";
      this.#appStep = undefined;
      if (!ok) {
        this.#appStepRefused = true;
        this.notify();
        return "stopped";
      }
    }
    return this.#isCurrent(run) ? "done" : "stale";
  }

  #finish(outcome: WizardOutcome): void {
    this.#cancelRun();
    this.#stopCountdown();
    this.#stopRetryTimer?.();
    this.#stopRetryTimer = undefined;
    this.#forget(); // the wizard is over: a kept pairing is not needed
    this.#appStep = undefined;
    this.#outcome = outcome;
    this.#go(WizardStep.Finished);
    for (const listener of [...this.#completed]) listener(outcome);
  }

  #go(step: WizardStep): void {
    this.#step = step;
    this.notify();
  }

  #newRun(): AbortController {
    this.#cancelRun();
    this.#storeFailed = false;
    return (this.#run = new AbortController());
  }

  /** Aborts what runs; its answers become stale. */
  #cancelRun(): void {
    const run = this.#run;
    this.#run = undefined;
    run?.abort();
    this.#appStep = undefined; // an app's step of a cancelled run is no longer running
  }

  #isCurrent(run: AbortController): boolean {
    return run === this.#run && !run.signal.aborted;
  }

  #stopCountdown(): void {
    this.#stopTimer?.();
    this.#stopTimer = undefined;
  }

  /** Stops everything that runs or waits (the wait, the countdown, the timers). A kept pairing stays kept: the panel may be reopened. */
  dispose(): void {
    this.#cancelRun();
    this.#stopCountdown();
    this.#stopRetryTimer?.();
    this.#stopRetryTimer = undefined;
  }

  #availability(): WizardCommandAvailability {
    const me = this;
    const is = (...steps: WizardStep[]): boolean => steps.includes(me.#step);
    return {
      get chooseServer() { return is(WizardStep.Choose) && me.canChooseServer; },
      get chooseOwnAi() { return is(WizardStep.Choose) && me.canChooseOwnAi; },
      get chooseDemo() { return is(WizardStep.Choose) && me.canChooseDemo; },
      get close() { return me.#step !== WizardStep.Finished; },
      get cancel() { return CANCELLABLE.has(me.#step) || (me.#step === WizardStep.Password && me.#passwordBusy); },
      get back() {
        switch (me.#step) {
          case WizardStep.ServerAddress:
          case WizardStep.OwnAccept:
            return me.#entry === WizardEntry.Settings || me.canChooseDemo || (me.canChooseServer && me.canChooseOwnAi);
          case WizardStep.OwnPick:
          case WizardStep.OwnPlainHttp:
          case WizardStep.OwnKey:
          case WizardStep.OwnResult:
          case WizardStep.OwnFailed:
          case WizardStep.OwnHelp:
          case WizardStep.OwnModel:
            return true;
          default:
            return false;
        }
      },
      get submitServer() { return is(WizardStep.ServerAddress); },
      get changeServer() { return !me.serverLocked && CHANGE_SERVER.has(me.#step); },
      get retry() {
        switch (me.#step) {
          case WizardStep.Unreachable:
          case WizardStep.PairFailed:
          case WizardStep.OwnFailed:
          case WizardStep.OwnHelp:
          case WizardStep.PasswordError:
            return true;
          case WizardStep.StartFailed:
            return me.#retryAt === undefined || me.#clock.now() >= me.#retryAt;
          default:
            return false;
        }
      },
      get newCode() { return is(WizardStep.Denied, WizardStep.Expired); },
      get usePassword() { return me.passwordFallback && is(WizardStep.PairCode, WizardStep.ServerTooOld); },
      get backToCode() { return !me.#passwordBusy && is(WizardStep.Password, WizardStep.PasswordError); },
      get signInWithPassword() { return !me.#passwordBusy && is(WizardStep.Password); },
      get openPairingPage() { return is(WizardStep.PairCode) && me.#pairingPage !== undefined; },
      get copyCode() { return is(WizardStep.PairCode) && me.#userCode !== undefined; },
      get accept() { return is(WizardStep.OwnAccept) && me.#accepted; },
      get serverModeInstead() { return is(WizardStep.OwnAccept) && me.canChooseServer; },
      get selectPreset() { return is(WizardStep.OwnPick); },
      get selectFound() { return is(WizardStep.OwnPick); },
      get useEndpoint() { return is(WizardStep.OwnPick); },
      get confirmPlainHttp() { return is(WizardStep.OwnPlainHttp); },
      get submitKey() { return is(WizardStep.OwnKey); },
      get enterKey() {
        return is(WizardStep.OwnFailed) && me.#problem === EndpointProblem.KeyRejected && me.#pending !== undefined && !me.#pending.allowPlainHttpInLan;
      },
      get showHelp() { return is(WizardStep.OwnFailed) && me.#problem === EndpointProblem.OriginRefused; },
      get continue() { return is(WizardStep.OwnResult) || (is(WizardStep.OwnModel) && !!me.#selectedModel); },
      get connectOrganisation() { return is(WizardStep.Settings) && me.canChooseServer; },
      get changeEndpoint() { return is(WizardStep.Settings) && me.canChooseOwnAi; },
      get signOut() { return is(WizardStep.Settings) && me.#options.current !== undefined; },
      get confirmSignOut() { return is(WizardStep.SignOut); },
    };
  }
}

/** A kept pairing that passed the checks: its server, and what the keeper held. */
interface KeptPairing {
  readonly server: URL;
  readonly saved: SavedPairing;
}

/** The typed endpoint address: http(s), no user name, query and fragment dropped; undefined when it is none. */
function parseEndpoint(text: string): URL | undefined {
  let url: URL;
  try {
    url = new URL((text ?? "").trim());
  } catch {
    return undefined;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || !url.hostname) return undefined;
  url.search = "";
  url.hash = "";
  return url;
}

function toUrl(address: string | URL): URL {
  return address instanceof URL ? address : new URL(address);
}

function passwordFailureOf(e: unknown): PasswordFailure {
  if (e instanceof FadenstackBadCredentialsError) return PasswordFailure.BadCredentials;
  if (e instanceof FadenstackHttpsRequiredError) return PasswordFailure.HttpsRequired;
  if (e instanceof ServerCertificateError) return PasswordFailure.CertificateNotTrusted;
  if (isNoAnswer(e)) return PasswordFailure.Unreachable;
  if (e instanceof FadenstackApiError && (e.code === "not_fadenstack" || e.code === "redirect")) return PasswordFailure.NotFadenstack;
  return PasswordFailure.Other;
}
