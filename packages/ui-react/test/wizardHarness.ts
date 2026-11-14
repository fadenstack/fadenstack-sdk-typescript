import {
  EndpointPlace,
  EndpointPreset,
  FadenstackBadCredentialsError,
  FadenstackPairingDeniedError,
  FadenstackPairingExpiredError,
  FadenstackPairingUnsupportedError,
  FadenstackUnreachableError,
  ServerCertificateError,
  type EndpointProblem,
  type SignedInUser,
} from "@fadenstack/client";
import {
  AgentAccess,
  ConnectionMode,
  ConnectionWizardViewModel,
  WizardEntry,
  WizardPoint,
  WizardStep,
  type ConnectionResult,
  type PairingApproval,
  type UiStrings,
  type WizardCommandAvailability,
  type WizardOptions,
} from "@fadenstack/ui";

import {
  DEFAULT_OPTIONS,
  FakeClipboard,
  FakeConnectionStore,
  FakeEndpointChecker,
  FakeKeyStore,
  FakeLinks,
  FakeServerSignIn,
  FakeStep,
  ManualClock,
  flush,
  failingReport,
  makeTicket,
  usableReport,
} from "../../ui/test/wizardFakes.js";

// A real ConnectionWizardViewModel on fakes, in a given language, driven to any WizardStep before a skin draws it. Shared by the
// React and the Vue tests: nothing here knows a framework. (The fakes are the view model's own: packages/ui/test/wizardFakes.ts.)

export const ADDRESS = "https://ai.example.test";
export const OLLAMA = "http://localhost:11434/v1";
export const LAN = "http://192.168.1.20:11434/v1";
const ANA: SignedInUser = { id: "aaaaaaaa-1111-2222-3333-444444444444", email: "ana@example.test", displayName: "Ana" };

export class Harness {
  readonly store = new FakeConnectionStore();
  readonly sign: FakeServerSignIn;
  readonly keys = new FakeKeyStore();
  readonly checker = new FakeEndpointChecker();
  readonly clock = new ManualClock();
  readonly links = new FakeLinks();
  readonly clipboard = new FakeClipboard();
  readonly vm: ConnectionWizardViewModel;

  constructor(strings: UiStrings, options: WizardOptions = DEFAULT_OPTIONS) {
    this.sign = new FakeServerSignIn(() => this.clock.now());
    this.vm = new ConnectionWizardViewModel(options, this.store, {
      server: this.sign, keys: this.keys, checker: this.checker, clock: this.clock, clipboard: this.clipboard, links: this.links, strings,
    });
  }

  /** Lets the answers through; a command that stays open (a pending fake) is not waited for. */
  async settle(result?: unknown): Promise<void> {
    if (result instanceof Promise) result.catch(() => undefined);
    await flush();
  }

  async start(): Promise<void> {
    await this.settle(this.vm.start());
  }

  async press(command: keyof WizardCommandAvailability, parameter?: unknown): Promise<void> {
    if (!this.vm.can[command]) throw new Error(`The command ${command} is not available at ${this.vm.step}.`);
    await this.settle((this.vm as unknown as Record<string, (p?: unknown) => unknown>)[command]!(parameter));
  }

  dispose(): void {
    this.vm.dispose();
  }
}

export const ALL_STEPS: readonly WizardStep[] = Object.values(WizardStep);

type Configure = (options: WizardOptions) => WizardOptions;
interface Recipe {
  options?: Configure;
  /** Scripts the fakes (before `start`). */
  script?: (h: Harness) => void;
  /** Drives from the start to the step. */
  drive: (h: Harness) => Promise<void>;
}

const withStep = (point: WizardPoint): { step: FakeStep; options: Configure } => {
  const step = new FakeStep(point);
  step.script.pending(); // the app's step never answers: it is the one running
  return { step, options: (o) => ({ ...o, steps: [step] }) };
};

const server = async (h: Harness): Promise<void> => {
  await h.start();
  await h.press("chooseServer");
};
const submit = async (h: Harness): Promise<void> => {
  await server(h);
  h.vm.serverAddressText = ADDRESS;
  await h.press("submitServer");
};
const passwordOn = (o: WizardOptions): WizardOptions => ({ ...o, passwordFallback: true });
const approval = (access: AgentAccess): PairingApproval => ({ person: ANA, agents: [{ agent: "main-agent", access }] });
const toPassword = async (h: Harness): Promise<void> => {
  await submit(h);
  await h.press("usePassword");
};
const own = async (h: Harness): Promise<void> => {
  await h.start();
  await h.press("chooseOwnAi");
};
const accepted = async (h: Harness, search = false): Promise<void> => {
  await own(h);
  h.vm.accepted = true;
  h.vm.searchConsent = search;
  await h.press("accept");
};
const useAddress = async (h: Harness, address: string): Promise<void> => {
  await accepted(h);
  h.vm.endpointAddressText = address;
  await h.press("useEndpoint");
};
const usePreset = async (h: Harness, preset: EndpointPreset): Promise<void> => {
  await accepted(h);
  await h.press("selectPreset", preset);
  await h.press("useEndpoint");
};
const failing = (h: Harness, ...problems: EndpointProblem[]): void => {
  h.checker.report.returns(failingReport(OLLAMA, ...problems));
};
const settings = (current?: ConnectionResult): Configure => (o) => ({ ...o, entry: WizardEntry.Settings, current });
const SERVER_CONNECTION: ConnectionResult = { mode: ConnectionMode.Server, server: new URL(`${ADDRESS}/`) };
const ENDPOINT_CONNECTION: ConnectionResult = { mode: ConnectionMode.Endpoint, endpoint: { baseUrl: new URL("https://api.openai.com/v1"), model: "gpt-test" } };

const recipes = (): Record<Exclude<WizardStep, "approved" | "finished">, Recipe> => {
  const before = withStep(WizardPoint.BeforeChoice);
  const precondition = withStep(WizardPoint.BeforeServerCheck);
  const beforeCheck = withStep(WizardPoint.BeforeEndpointCheck);
  const after = withStep(WizardPoint.AfterConnect);
  const modelsStep: Recipe = {
    script: (h) => h.checker.report.returns(usableReport(OLLAMA, "m1", "m1", "m2")),
    drive: async (h) => {
      await usePreset(h, EndpointPreset.ollama);
      await h.press("continue");
    },
  };
  return {
    beforeChoice: { options: before.options, drive: (h) => h.start() },
    choose: { drive: (h) => h.start() },
    settings: { options: settings(SERVER_CONNECTION), drive: (h) => h.start() },
    signOut: { options: settings(ENDPOINT_CONNECTION), drive: async (h) => { await h.start(); await h.press("signOut"); } },
    serverAddress: { drive: server },
    appPrecondition: { options: precondition.options, drive: submit },
    checking: { script: (h) => h.sign.checkScript.pending(), drive: submit },
    unreachable: { script: (h) => h.sign.checkScript.throws(new FadenstackUnreachableError("down")), drive: submit },
    certificateNotTrusted: { script: (h) => h.sign.checkScript.throws(new ServerCertificateError("not trusted")), drive: submit },
    notFadenstack: { script: (h) => h.sign.checkScript.throws(new Error("a web page")), drive: submit },
    serverAccepted: {
      drive: async (h) => {
        h.store.saveServer = () => new Promise<void>(() => undefined); // the app is still saving the address
        await submit(h);
      },
    },
    pairStarting: { script: (h) => h.sign.startScript.pending(), drive: submit },
    startFailed: { script: (h) => h.sign.startScript.throws(new FadenstackUnreachableError("down")), drive: submit },
    serverTooOld: { options: passwordOn, script: (h) => h.sign.startScript.throws(new FadenstackPairingUnsupportedError("too old")), drive: submit },
    pairCode: { options: passwordOn, drive: submit },
    denied: { script: (h) => h.sign.waitScript.throws(new FadenstackPairingDeniedError("denied")), drive: submit },
    expired: { script: (h) => h.sign.waitScript.throws(new FadenstackPairingExpiredError("expired")), drive: submit },
    pairFailed: { script: (h) => h.sign.waitScript.throws(new Error("failed")), drive: submit },
    redeeming: {
      options: (o) => ({ ...o, agents: ["main-agent", "second-agent"] }),
      script: (h) => {
        h.sign.startScript.returns(makeTwoAgentTicket(h));
        h.sign.waitScript.returns(approval(AgentAccess.Approved));
        h.sign.redeemScript.pending();
      },
      drive: submit,
    },
    noAccess: { script: (h) => h.sign.waitScript.returns(approval(AgentAccess.Refused)), drive: submit },
    password: { options: passwordOn, drive: toPassword },
    passwordError: {
      options: passwordOn,
      script: (h) => h.sign.passwordScript.throws(new FadenstackBadCredentialsError()),
      drive: async (h) => {
        await toPassword(h);
        h.vm.email = "ana@example.test";
        await h.settle(h.vm.signInWithPassword("not-the-password"));
      },
    },
    signedIn: { script: (h) => h.sign.waitScript.returns(approval(AgentAccess.Approved)), drive: submit },
    ownAccept: { drive: own },
    ownSearching: { script: (h) => h.checker.find.pending(), drive: (h) => accepted(h, true) },
    ownPick: { drive: (h) => accepted(h) },
    ownPlainHttp: {
      script: (h) => h.checker.places.set("192.168.1.20", EndpointPlace.LocalNetwork),
      drive: (h) => useAddress(h, LAN),
    },
    ownKey: { drive: (h) => usePreset(h, EndpointPreset.openAi) },
    beforeCheck: { options: beforeCheck.options, drive: (h) => usePreset(h, EndpointPreset.ollama) },
    ownChecking: { script: (h) => h.checker.report.pending(), drive: (h) => usePreset(h, EndpointPreset.ollama) },
    ownFailed: { script: (h) => failing(h, "Unreachable"), drive: (h) => usePreset(h, EndpointPreset.ollama) },
    ownHelp: {
      script: (h) => failing(h, "OriginRefused"),
      drive: async (h) => {
        await usePreset(h, EndpointPreset.ollama);
        await h.press("showHelp");
      },
    },
    ownResult: { drive: (h) => usePreset(h, EndpointPreset.ollama) },
    ownModel: modelsStep,
    ownDone: { script: (h) => { h.store.save = () => new Promise<void>(() => undefined); }, drive: async (h) => { await usePreset(h, EndpointPreset.ollama); await h.press("continue"); } },
    afterConnect: { options: after.options, drive: async (h) => { await usePreset(h, EndpointPreset.ollama); await h.press("continue"); } },
  };
};

const makeTwoAgentTicket = (h: Harness) => makeTicket(h.clock.now() + 600_000, "BDWP-HTQX", "main-agent", "second-agent");

/**
 * A wizard standing at `step`, in `strings`' language, with the machine policy open. `approved` lasts one tick in the real
 * wizard (the sign-ins are collected at once), so the view model it returns is the one at `redeeming` with its `step` read
 * as `approved`; `finished` is the real end (closed).
 */
export async function reach(step: WizardStep, strings: UiStrings): Promise<{ h: Harness; vm: ConnectionWizardViewModel }> {
  if (step === WizardStep.Finished) {
    const h = new Harness(strings);
    await h.start();
    h.vm.close();
    return { h, vm: h.vm };
  }
  if (step === WizardStep.Approved) {
    const { h, vm } = await reach(WizardStep.Redeeming, strings);
    const lying = new Proxy(vm, {
      get(target, prop) {
        if (prop === "step") return WizardStep.Approved;
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
    return { h, vm: lying };
  }
  const recipe = recipes()[step];
  const options = recipe.options ? recipe.options(DEFAULT_OPTIONS) : DEFAULT_OPTIONS;
  const h = new Harness(strings, options);
  recipe.script?.(h);
  await recipe.drive(h);
  if (h.vm.step !== step) throw new Error(`Wanted ${step} but the wizard stands at ${h.vm.step}.`);
  return { h, vm: h.vm };
}
