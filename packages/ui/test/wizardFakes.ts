import { MachinePolicy } from "@fadenstack/agents";
import {
  EndpointPlace,
  EndpointReport,
  EndpointServer,
  StaticTokenProvider,
  type EndpointProblem,
  type EndpointReportData,
  type ModelEndpoint,
  type PairingExport,
  type TokenProvider,
} from "@fadenstack/client";
import {
  AgentAccess,
  ConnectionWizardViewModel,
  createPairingTicket,
  germanStrings,
  type UiStrings,
  type AcceptanceRecord,
  type AgentSignIn,
  type ConnectionResult,
  type ConnectionStore,
  type EndpointChecker,
  type EndpointKeyStore,
  type LinkOpener,
  type LocalEndpoint,
  type PairingApproval,
  type PairingKeeper,
  type PairingTicket,
  type SavedPairing,
  type ServerSignIn,
  type WizardClock,
  type WizardCommandAvailability,
  type WizardOptions,
  type WizardOutcome,
  type WizardPoint,
  type WizardStep,
  type WizardStepContext,
  type WizardStepHandler,
} from "@fadenstack/ui";

// The wizard's fakes (.NET: WizardFakes.cs): scripted answers, time by hand, and a rig that drives the view model as a skin
// would. JS has no thread of its own to wait on, so a command is pressed and the microtasks are let through (`flush`).

/** Lets every pending microtask and promise continuation run. */
export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** A call the test answers later (cancel and stale answers): complete it, fail it, or let the wizard abort it. */
export class PendingAnswer<T> {
  /** The signal the call was given (undefined until it is called). */
  signal: AbortSignal | undefined;
  isCompleted = false;
  readonly promise: Promise<T>;
  #resolve!: (value: T) => void;
  #reject!: (error: unknown) => void;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    this.promise.catch(() => undefined); // a failure the wizard never reads is not an unhandled rejection
  }

  complete(value: T): void {
    this.isCompleted = true;
    this.#resolve(value);
  }

  fail(error: unknown): void {
    this.isCompleted = true;
    this.#reject(error);
  }
}

/** The answers of one fake method, in the order they were scripted; then the fallback, or an error when there is none. */
export class Scripted<T> {
  calls = 0;
  readonly #answers: ((signal: AbortSignal) => Promise<T>)[] = [];
  readonly #fallback: ((signal: AbortSignal) => Promise<T>) | undefined;

  constructor(fallback?: (signal: AbortSignal) => Promise<T>) {
    this.#fallback = fallback;
  }

  get hasScript(): boolean {
    return this.#answers.length > 0;
  }

  returns(value: T): this {
    this.#answers.push(() => Promise.resolve(value));
    return this;
  }

  throws(error: unknown): this {
    this.#answers.push(() => Promise.reject(error));
    return this;
  }

  /** A call that stays open until the test completes it; with `honourCancel` it ends when its signal aborts. */
  pending(honourCancel = true): PendingAnswer<T> {
    const pending = new PendingAnswer<T>();
    this.#answers.push((signal) => {
      pending.signal = signal;
      if (honourCancel) signal.addEventListener("abort", () => pending.fail(signal.reason), { once: true });
      return pending.promise;
    });
    return pending;
  }

  next(signal: AbortSignal): Promise<T> {
    this.calls++;
    const answer = this.#answers.shift();
    if (answer) return answer(signal);
    return this.#fallback ? this.#fallback(signal) : Promise.reject(new Error("No answer was scripted for this call."));
  }

  /** A call that never ends by itself (a wait for an approval), but ends when it is aborted. */
  static forever<T>(signal: AbortSignal): Promise<T> {
    return new Promise<T>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }
}

export const PAIRING_SECRET = "PAIRING-SECRET-9f3a";

export function makeTicket(expiresAt: number, code = "BDWP-HTQX", ...agents: string[]): PairingTicket {
  return createPairingTicket({
    userCode: code, verificationUri: new URL("https://ai.example.test/pair"),
    verificationUriComplete: new URL(`https://ai.example.test/pair?code=${code}`), expiresAt,
    agents: agents.length === 0 ? ["main-agent"] : agents, handle: { code },
  });
}

const WATERMARK = { status: "Unknown", source: null, checked: null, requested: false, confirmed: null } as const;

/** A report; every field has the value of a usable one unless `over` says otherwise. */
export function makeReport(baseUrl: string | URL, over: Partial<EndpointReportData> = {}): EndpointReport {
  return new EndpointReport({
    baseUrl: String(baseUrl), model: "m1", checkedAt: 0, server: EndpointServer.Unknown, serverVersion: null, dialect: "openai-compatible",
    reachable: true, keyAccepted: true, models: ["m1"], chat: true, usage: true, toolCalls: true, vision: null, contextLength: null,
    modelContextLength: null, pictures: false, watermark: { ...WATERMARK }, problems: [], ...over,
  });
}

export const usableReport = (baseUrl: string | URL, model = "m1", ...models: string[]): EndpointReport =>
  makeReport(baseUrl, { model, models: models.length > 0 ? models : [model] });

/** A report with these problems that is not usable. */
export const failingReport = (baseUrl: string | URL, ...problems: EndpointProblem[]): EndpointReport =>
  makeReport(baseUrl, {
    reachable: !problems.includes("Unreachable"), keyAccepted: problems.includes("KeyRejected") ? false : null, chat: null, model: "", models: [], problems,
  });

export interface WaitCall {
  ticket: PairingTicket;
  onRetrying: (retrying: boolean) => void;
  signal: AbortSignal;
}

export interface PasswordCall {
  server: string;
  email: string;
  password: string;
}

/** The server side of path A, scripted. Without a script: the health check passes, a ticket is given, the wait never ends. */
export class FakeServerSignIn implements ServerSignIn {
  readonly checkScript: Scripted<void> = new Scripted<void>(() => Promise.resolve());
  readonly startScript: Scripted<PairingTicket>;
  readonly waitScript = new Scripted<PairingApproval>(Scripted.forever);
  /** Without a script an agent is approved. */
  readonly redeemScript = new Scripted<AgentSignIn>();
  readonly passwordScript = new Scripted<PairingApproval>();
  readonly checked: string[] = [];
  readonly started: string[] = [];
  readonly waited: WaitCall[] = [];
  readonly redeemed: string[] = [];
  readonly passwordsTried: PasswordCall[] = [];
  /** What `resume` was asked for: the server and the saved pairing's user code. */
  readonly resumed: { server: string; userCode: string }[] = [];
  /** When set, `resume` fails with it. */
  resumeFailure: Error | undefined;

  constructor(now: () => number) {
    this.startScript = new Scripted<PairingTicket>(() => Promise.resolve(makeTicket(now() + 600_000)));
  }

  check(server: URL, signal: AbortSignal): Promise<void> {
    this.checked.push(server.href);
    return this.checkScript.next(signal);
  }

  start(server: URL, signal: AbortSignal): Promise<PairingTicket> {
    this.started.push(server.href);
    return this.startScript.next(signal);
  }

  wait(ticket: PairingTicket, onRetrying: (retrying: boolean) => void, signal: AbortSignal): Promise<PairingApproval> {
    this.waited.push({ ticket, onRetrying, signal });
    return this.waitScript.next(signal);
  }

  redeem(_ticket: PairingTicket, agent: string, signal: AbortSignal): Promise<AgentSignIn> {
    this.redeemed.push(agent);
    return this.redeemScript.hasScript ? this.redeemScript.next(signal) : Promise.resolve({ agent, access: AgentAccess.Approved });
  }

  signInWithPassword(server: URL, email: string, password: string, signal: AbortSignal): Promise<PairingApproval> {
    this.passwordsTried.push({ server: server.href, email, password });
    return this.passwordScript.next(signal);
  }

  export(ticket: PairingTicket): PairingExport {
    return {
      agent: ticket.agents[0]!, agents: [...ticket.agents], ignoredAgents: [], userCode: ticket.userCode,
      verificationUri: ticket.verificationUri.href, verificationUriComplete: ticket.verificationUriComplete.href,
      expiresAt: ticket.expiresAt, intervalMs: 5000, pairingCode: PAIRING_SECRET,
    };
  }

  resume(server: URL, saved: PairingExport): PairingTicket {
    this.resumed.push({ server: server.href, userCode: saved.userCode });
    if (this.resumeFailure) throw this.resumeFailure;
    return createPairingTicket({
      userCode: saved.userCode, verificationUri: new URL(saved.verificationUri), verificationUriComplete: new URL(saved.verificationUriComplete),
      expiresAt: saved.expiresAt, agents: saved.agents, handle: { resumed: true },
    });
  }
}

/** Path B's checks, scripted. Without a script: nothing is found, a usable report names the endpoint's model (or "m1"). */
export class FakeEndpointChecker implements EndpointChecker {
  readonly find = new Scripted<readonly LocalEndpoint[]>(() => Promise.resolve([]));
  /** Where a host points; the internet when not listed. */
  readonly places = new Map<string, EndpointPlace>([["localhost", EndpointPlace.ThisComputer], ["127.0.0.1", EndpointPlace.ThisComputer]]);
  readonly report = new Scripted<EndpointReport>();
  readonly placeAsked: string[] = [];
  readonly checked: ModelEndpoint[] = [];
  /** When set, telling where an address points fails with it. */
  placeFailure: Error | undefined;
  /** Answer `placeOf` with a promise, as .NET does, instead of at once. */
  asyncPlace = false;

  findLocal(signal: AbortSignal): Promise<readonly LocalEndpoint[]> {
    return this.find.next(signal);
  }

  placeOf(baseUrl: URL): EndpointPlace | Promise<EndpointPlace> {
    this.placeAsked.push(baseUrl.href);
    if (this.placeFailure) {
      if (this.asyncPlace) return Promise.reject(this.placeFailure);
      throw this.placeFailure;
    }
    const place = this.places.get(baseUrl.hostname) ?? EndpointPlace.Internet;
    return this.asyncPlace ? Promise.resolve(place) : place;
  }

  check(endpoint: ModelEndpoint, signal: AbortSignal): Promise<EndpointReport> {
    this.checked.push(endpoint);
    return this.report.hasScript ? this.report.next(signal) : Promise.resolve(usableReport(endpoint.baseUrl, endpoint.model || "m1"));
  }
}

export class FakeConnectionStore implements ConnectionStore {
  readonly servers: string[] = [];
  readonly saved: ConnectionResult[] = [];
  readonly acceptances: AcceptanceRecord[] = [];
  readonly signOuts: boolean[] = [];
  /** When set, every call fails with it and keeps nothing (the app's settings could not be written). */
  failure: Error | undefined;

  saveServer(server: URL): Promise<void> {
    return this.#keep(() => this.servers.push(server.href));
  }

  save(result: ConnectionResult): Promise<void> {
    return this.#keep(() => this.saved.push(result));
  }

  saveAcceptance(record: AcceptanceRecord): Promise<void> {
    return this.#keep(() => this.acceptances.push(record));
  }

  signOut(deleteLocalChats: boolean): Promise<void> {
    return this.#keep(() => this.signOuts.push(deleteLocalChats));
  }

  #keep(keep: () => void): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    keep();
    return Promise.resolve();
  }
}

export class FakeKeyStore implements EndpointKeyStore {
  readonly saved: { endpoint: string; key: string }[] = [];
  readonly providers: TokenProvider[] = [];
  readonly removed: string[] = [];

  save(endpoint: URL, key: string): Promise<TokenProvider> {
    this.saved.push({ endpoint: endpoint.href, key });
    const provider = new StaticTokenProvider(key);
    this.providers.push(provider);
    return Promise.resolve(provider);
  }

  remove(endpoint: URL): Promise<void> {
    this.removed.push(endpoint.href);
    return Promise.resolve();
  }
}

export class FakeLinks implements LinkOpener {
  readonly opened: string[] = [];

  tryOpen(address: URL): boolean {
    this.opened.push(address.href);
    return true;
  }
}

export class FakeClipboard {
  readonly texts: string[] = [];

  setText(text: string): void {
    this.texts.push(text);
  }
}

/** An app step with a point and a scripted result (true unless scripted); it keeps what it was shown. */
export class FakeStep implements WizardStepHandler {
  readonly script = new Scripted<boolean>(() => Promise.resolve(true));
  readonly contexts: WizardStepContext[] = [];
  /** Called inside `run`, before anything is awaited: what a test reads right after the command to see the gesture. */
  onRun: (() => void) | undefined;

  constructor(readonly point: WizardPoint, private readonly name = "step", private readonly log?: string[]) {}

  run(context: WizardStepContext, signal: AbortSignal): Promise<boolean> {
    this.contexts.push(context);
    this.log?.push(this.name);
    this.onRun?.();
    return this.script.next(signal);
  }
}

/** Time by hand: `advance` moves `now()` and runs the timers that fall due, in order, those they start too. */
export class ManualClock implements WizardClock {
  time = Date.UTC(2026, 10, 14, 10, 0, 0);
  readonly #timers: { due: number; action: () => void; stopped: boolean }[] = [];

  now(): number {
    return this.time;
  }

  /** The timers that are neither run nor stopped. */
  get activeTimers(): number {
    return this.#timers.filter((t) => !t.stopped).length;
  }

  after(delayMs: number, action: () => void): () => void {
    const timer = { due: this.time + Math.max(0, delayMs), action, stopped: false };
    this.#timers.push(timer);
    return () => {
      timer.stopped = true;
    };
  }

  advance(ms: number): void {
    const target = this.time + ms;
    for (;;) {
      const due = this.#timers.filter((t) => !t.stopped && t.due <= target).sort((a, b) => a.due - b.due)[0];
      if (!due) break;
      this.time = Math.max(this.time, due.due);
      due.stopped = true;
      due.action();
    }
    this.time = target;
  }
}

/** A keeper in memory, as `chrome.storage.session` is: what it holds, and what it was asked, in order. */
export class MemoryKeeper implements PairingKeeper {
  saved: SavedPairing | undefined;
  readonly calls: string[] = [];
  /** When set, every call fails with it. */
  failure: Error | undefined;
  /** Answer after a macrotask, as the extension's storage does. */
  slow = false;

  async keep(saved: SavedPairing): Promise<void> {
    await this.#io("keep");
    this.saved = saved;
  }

  async restore(): Promise<SavedPairing | undefined> {
    await this.#io("restore");
    return this.saved;
  }

  async forget(): Promise<void> {
    await this.#io("forget");
    this.saved = undefined;
  }

  async #io(call: string): Promise<void> {
    this.calls.push(call);
    if (this.slow) await flush();
    if (this.failure) throw this.failure;
  }
}

export const DEFAULT_OPTIONS: WizardOptions = { appName: "Test app", termsVersion: "2026-11", agents: ["main-agent"] };

/** A wizard with all its fakes; every call a test makes is let through with `flush` unless a fake keeps it open. */
export class WizardRig {
  readonly options: WizardOptions;
  readonly store = new FakeConnectionStore();
  readonly sign: FakeServerSignIn;
  readonly keys = new FakeKeyStore();
  readonly checker = new FakeEndpointChecker();
  readonly clock = new ManualClock();
  readonly links = new FakeLinks();
  readonly clipboard = new FakeClipboard();
  readonly language = "de";
  readonly vm: ConnectionWizardViewModel;
  /** Every step the wizard came to, in order. */
  readonly steps: WizardStep[] = [];
  readonly completed: WizardOutcome[] = [];
  /** Commands that rejected. */
  readonly failures: unknown[] = [];

  constructor(configure?: (options: WizardOptions) => WizardOptions, strings: UiStrings = germanStrings) {
    this.options = configure ? configure(DEFAULT_OPTIONS) : DEFAULT_OPTIONS;
    this.sign = new FakeServerSignIn(() => this.clock.now());
    this.vm = new ConnectionWizardViewModel(this.options, this.store, {
      server: this.sign, keys: this.keys, checker: this.checker, clock: this.clock, clipboard: this.clipboard, links: this.links,
      language: () => this.language, strings,
    });
    this.vm.subscribe(() => {
      if (this.steps.at(-1) !== this.vm.step) this.steps.push(this.vm.step);
    });
    this.vm.onCompleted((outcome) => this.completed.push(outcome));
  }

  async start(): Promise<void> {
    await this.settle(this.vm.start());
  }

  /** Presses a command as a skin would: it must be available. */
  async press(command: keyof WizardCommandAvailability, parameter?: unknown): Promise<void> {
    if (!this.vm.can[command]) throw new Error(`The command ${command} is not available at ${this.vm.step}.`);
    await this.settle((this.vm as unknown as Record<string, (p?: unknown) => unknown>)[command]!(parameter));
  }

  /** Lets the answers through and fails the test on a command that rejected. */
  async settle(result?: unknown): Promise<void> {
    if (result instanceof Promise) result.catch((e: unknown) => this.failures.push(e));
    await flush();
    if (this.failures.length > 0) throw this.failures[0];
  }

  /** Moves the clock, then lets what the timers started finish. */
  async advance(ms: number): Promise<void> {
    this.clock.advance(ms);
    await this.settle();
  }

  /** The wizard came through exactly these steps, one after the other, at some point. */
  assertPassed(...path: WizardStep[]): void {
    for (let i = 0; i + path.length <= this.steps.length; i++) {
      if (path.every((step, j) => this.steps[i + j] === step)) return;
    }
    throw new Error(`Expected the path ${path.join(" > ")} but the wizard went ${this.steps.join(" > ")}`);
  }

  dispose(): void {
    this.vm.dispose();
  }
}

export const policyOf = (init: ConstructorParameters<typeof MachinePolicy>[0]): MachinePolicy => new MachinePolicy(init);
