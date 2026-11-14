import { PolicyAccess } from "@fadenstack/agents";
import {
  EndpointPlace,
  EndpointPreset,
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
  type SignedInUser,
} from "@fadenstack/client";
import {
  AddressProblem,
  AgentAccess,
  ConnectionMode,
  ConnectionWizardViewModel,
  PasswordFailure,
  StartFailure,
  WizardEntry,
  WizardOutcome,
  WizardPoint,
  WizardStep,
  createEndpointChecker,
  type AgentSignIn,
  type ConnectionResult,
  type LocalEndpoint,
  type PairingApproval,
  type WizardCommandAvailability,
  type WizardOptions,
} from "@fadenstack/ui";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_OPTIONS,
  FakeConnectionStore,
  FakeKeyStore,
  FakeServerSignIn,
  FakeStep,
  MemoryKeeper,
  PAIRING_SECRET,
  PendingAnswer,
  WizardRig,
  failingReport,
  flush,
  makeReport,
  makeTicket,
  policyOf,
  usableReport,
} from "./wizardFakes.js";

// sdk/51 I15 §1-§3: each arrow of the wizard's three state diagrams is a test, driven as a skin would drive it (`start()` and
// the commands) against fakes; then the policy, the address rule, the app steps, stale answers and the rule that no secret
// stays in the view model. .NET: ConnectionWizardTests. The tests of the .NET UI thread are not ported: JS has none. The last
// parts are TypeScript's own: the gesture rule and the pairing keeper (I15 §2).

const ORG = "https://ai.example.test/";
const ADDRESS = "https://ai.example.test";
const PAUSE = 1500;
const CORP = "https://ai.corp.test/";

const ANA: SignedInUser = { id: "aaaaaaaa-1111-2222-3333-444444444444", email: "ana@example.test", displayName: "Ana" };
const approve = (...agents: string[]): PairingApproval => ({ person: ANA, agents: agents.map((agent) => ({ agent, access: AgentAccess.Approved })) });
const refused = (agent: string): AgentSignIn => ({ agent, access: AgentAccess.Refused });
const approved = (agent: string): AgentSignIn => ({ agent, access: AgentAccess.Approved });

const SERVER_CONNECTION: ConnectionResult = { mode: ConnectionMode.Server, server: new URL(ORG), agents: [approved("main-agent")] };
const ENDPOINT_CONNECTION: ConnectionResult = {
  mode: ConnectionMode.Endpoint, endpoint: { baseUrl: new URL("https://api.openai.com/v1"), model: "gpt-test" },
};

type Configure = (options: WizardOptions) => WizardOptions;
const rigs: WizardRig[] = [];
afterEach(() => {
  for (const rig of rigs.splice(0)) rig.dispose(); // no timer or wait outlives a test
});
const track = (rig: WizardRig): WizardRig => {
  rigs.push(rig);
  return rig;
};
const make = (configure?: Configure): WizardRig => track(new WizardRig(configure));
const made = (options: Partial<WizardOptions>): Configure => (o) => ({ ...o, ...options });

const settingsRig = (current: ConnectionResult = SERVER_CONNECTION): WizardRig =>
  make(made({ entry: WizardEntry.Settings, current }));

/** First run, "Connect to my organisation", the address typed and submitted: the code is shown. */
async function pairCode(configure?: Configure, before?: (rig: WizardRig) => void): Promise<WizardRig> {
  const rig = make(configure);
  before?.(rig);
  await rig.start();
  await rig.press("chooseServer");
  rig.vm.serverAddressText = ADDRESS;
  await rig.press("submitServer");
  expect(rig.vm.step).toBe(WizardStep.PairCode);
  return rig;
}

/** First run, "Use my own AI", the terms accepted: the pick (after the search when asked for). */
async function ownPick(configure?: Configure, before?: (rig: WizardRig) => void, search = false): Promise<WizardRig> {
  const rig = make(configure);
  before?.(rig);
  await rig.start();
  await rig.press("chooseOwnAi");
  rig.vm.accepted = true;
  rig.vm.searchConsent = search;
  await rig.press("accept");
  return rig;
}

const pick = (rig: WizardRig, preset: EndpointPreset): Promise<void> => rig.press("selectPreset", preset);
const useEndpoint = (rig: WizardRig): Promise<void> => rig.press("useEndpoint");
const type = (rig: WizardRig, address: string): void => {
  rig.vm.endpointAddressText = address;
};
const unavailable = (rig: WizardRig, command: keyof WizardCommandAvailability, why = "the command should not be available"): void => {
  expect(rig.vm.can[command], why).toBe(false);
};
const href = (url: string | URL | undefined): string | undefined => (url === undefined ? undefined : String(url));

/** Goes to the address with a policy-free first run and submits it. */
async function submitAddress(rig: WizardRig, address = ADDRESS): Promise<void> {
  await rig.start();
  await rig.press("chooseServer");
  rig.vm.serverAddressText = address;
  await rig.press("submitServer");
}

// =====================================================================================================================
// §1 Entry
// =====================================================================================================================

describe("wizard: §1 entry", () => {
  it("FirstRun goes to Choose when the app has no steps", async () => {
    const rig = make();
    await rig.start();
    expect(rig.vm.step).toBe(WizardStep.Choose);
    expect(rig.vm.outcome).toBe(WizardOutcome.None);
    expect(rig.vm.isBusy).toBe(false);
  });

  it("BeforeChoice goes to Choose when the app step says true", async () => {
    const step = new FakeStep(WizardPoint.BeforeChoice);
    const running = step.script.pending();
    const rig = make(made({ steps: [step] }));
    await rig.start();
    expect(rig.vm.step).toBe(WizardStep.BeforeChoice);
    expect(rig.vm.appStep).toBe(step);
    expect(rig.vm.isBusy).toBe(true);
    expect(step.contexts.map((c) => c.point)).toEqual([WizardPoint.BeforeChoice]);
    running.complete(true);
    await flush();
    expect(rig.vm.step).toBe(WizardStep.Choose);
    expect(rig.vm.appStep).toBeUndefined();
    expect(rig.vm.appStepRefused).toBe(false);
  });

  it.each([["says false", false], ["throws", new Error("licence screen failed")]] as const)(
    "BeforeChoice goes to Finished (Closed) when the app step %s", async (_, answer) => {
      const step = new FakeStep(WizardPoint.BeforeChoice);
      if (answer === false) step.script.returns(false);
      else step.script.throws(answer);
      const rig = make(made({ steps: [step] }));
      await rig.start();
      expect(rig.vm.step).toBe(WizardStep.Finished);
      expect(rig.vm.outcome).toBe(WizardOutcome.Closed);
      expect(rig.completed).toEqual([WizardOutcome.Closed]);
      expect(rig.store.saved).toEqual([]);
    });

  it.each([[WizardEntry.ServerKnown, false], [WizardEntry.ReSignIn, true]] as const)(
    "a known server (%s) goes straight to PairStarting", async (entry, signInEnded) => {
      const rig = make(made({ entry, server: new URL(ORG) }));
      const start = rig.sign.startScript.pending();
      await rig.start();
      expect(rig.vm.step).toBe(WizardStep.PairStarting);
      expect(rig.vm.signInEnded).toBe(signInEnded);
      expect(href(rig.vm.serverUrl)).toBe(ORG);
      expect(rig.sign.started).toEqual([ORG]);
      expect(rig.sign.checked).toEqual([]); // a start counts against the server's limit; the wizard never probes with one
      expect(start.isCompleted).toBe(false);
    });

  it.each([WizardEntry.ServerKnown, WizardEntry.ReSignIn])("a known entry (%s) without a server goes to ServerAddress", async (entry) => {
    const rig = make(made({ entry }));
    await rig.start();
    expect(rig.vm.step).toBe(WizardStep.ServerAddress);
    expect(rig.sign.started).toEqual([]);
    expect(rig.vm.signInEnded).toBe(entry === WizardEntry.ReSignIn);
  });

  it("a policy server wins over the app's server on a known entry", async () => {
    const policy = policyOf({ server: new URL(CORP), standalone: PolicyAccess.Forbidden });
    const rig = make(made({ entry: WizardEntry.ServerKnown, server: new URL(ORG), policy }));
    rig.sign.startScript.pending();
    await rig.start();
    expect(rig.sign.started).toEqual([CORP]);
  });

  it("the Settings entry goes to Settings", async () => {
    const rig = settingsRig();
    await rig.start();
    expect(rig.vm.step).toBe(WizardStep.Settings);
    expect(rig.vm.current).toBe(SERVER_CONNECTION);
  });

  it("Settings goes to ServerAddress on ConnectOrganisation", async () => {
    const rig = settingsRig(ENDPOINT_CONNECTION);
    await rig.start();
    await rig.press("connectOrganisation");
    expect(rig.vm.step).toBe(WizardStep.ServerAddress);
  });

  it("Settings goes to OwnAccept on ChangeEndpoint", async () => {
    const rig = settingsRig();
    await rig.start();
    await rig.press("changeEndpoint");
    expect(rig.vm.step).toBe(WizardStep.OwnAccept);
    expect(rig.vm.accepted).toBe(false);
  });

  it("Settings goes to SignOut on SignOut", async () => {
    const rig = settingsRig();
    await rig.start();
    await rig.press("signOut");
    expect(rig.vm.step).toBe(WizardStep.SignOut);
    expect(rig.vm.deleteLocalChats).toBe(false);
  });

  it("the SignOut command is not available without a current connection", async () => {
    const rig = make(made({ entry: WizardEntry.Settings, current: undefined }));
    await rig.start();
    expect(rig.vm.step).toBe(WizardStep.Settings);
    unavailable(rig, "signOut");
  });

  it.each([false, true])("SignOut goes to Finished (SignedOut) on ConfirmSignOut (delete chats: %s)", async (deleteLocalChats) => {
    const rig = settingsRig();
    await rig.start();
    await rig.press("signOut");
    rig.vm.deleteLocalChats = deleteLocalChats;
    await rig.press("confirmSignOut");
    expect(rig.vm.step).toBe(WizardStep.Finished);
    expect(rig.vm.outcome).toBe(WizardOutcome.SignedOut);
    expect(rig.store.signOuts).toEqual([deleteLocalChats]);
    expect(rig.keys.removed).toEqual([]); // a server sign-in has no endpoint key
    expect(rig.completed).toEqual([WizardOutcome.SignedOut]);
  });

  it("removing an endpoint removes its key from the key store", async () => {
    const rig = settingsRig(ENDPOINT_CONNECTION);
    await rig.start();
    await rig.press("signOut");
    await rig.press("confirmSignOut");
    expect(rig.vm.outcome).toBe(WizardOutcome.SignedOut);
    expect(rig.keys.removed).toEqual(["https://api.openai.com/v1"]);
    expect(rig.store.signOuts).toEqual([false]);
  });

  it("SignOut goes to Settings on Cancel and the chat box starts unticked again", async () => {
    const rig = settingsRig();
    await rig.start();
    await rig.press("signOut");
    rig.vm.deleteLocalChats = true;
    await rig.press("cancel");
    expect(rig.vm.step).toBe(WizardStep.Settings);
    expect(rig.store.signOuts).toEqual([]);
    await rig.press("signOut");
    expect(rig.vm.deleteLocalChats).toBe(false);
  });
});

describe("wizard: the choice", () => {
  it("Choose goes to ServerAddress", async () => {
    const rig = make();
    await rig.start();
    await rig.press("chooseServer");
    expect(rig.vm.step).toBe(WizardStep.ServerAddress);
  });

  it("Choose goes to OwnAccept", async () => {
    const rig = make();
    await rig.start();
    await rig.press("chooseOwnAi");
    expect(rig.vm.step).toBe(WizardStep.OwnAccept);
  });

  it("Choose goes to Finished (Demo)", async () => {
    const rig = make(made({ offersDemo: true }));
    await rig.start();
    await rig.press("chooseDemo");
    expect(rig.vm.step).toBe(WizardStep.Finished);
    expect(rig.vm.outcome).toBe(WizardOutcome.Demo);
    expect(rig.completed).toEqual([WizardOutcome.Demo]);
    expect(rig.store.saved).toEqual([]);
  });

  it("Choose goes to Finished (Closed) on Close and nothing goes on after it", async () => {
    const rig = make();
    await rig.start();
    await rig.press("close");
    expect(rig.vm.step).toBe(WizardStep.Finished);
    expect(rig.vm.outcome).toBe(WizardOutcome.Closed);
    unavailable(rig, "close");
    unavailable(rig, "chooseServer");
  });

  it("without the demo the demo is not offered", async () => {
    const rig = make();
    await rig.start();
    unavailable(rig, "chooseDemo");
  });

  it("only the server path offered goes straight to ServerAddress", async () => {
    const rig = make(made({ offersOwnAi: false }));
    await rig.start();
    expect(rig.vm.step).toBe(WizardStep.ServerAddress);
    expect(rig.vm.canChooseOwnAi).toBe(false);
    unavailable(rig, "back", "there is no choice to go back to");
  });

  it("only own AI offered goes straight to OwnAccept", async () => {
    const rig = make(made({ offersServer: false }));
    await rig.start();
    expect(rig.vm.step).toBe(WizardStep.OwnAccept);
  });

  it("own AI forbidden by the policy leaves one path and goes straight to ServerAddress", async () => {
    const rig = make(made({ policy: policyOf({ standalone: PolicyAccess.Forbidden }) }));
    await rig.start();
    expect(rig.vm.canChooseOwnAi).toBe(false);
    expect(rig.vm.step).toBe(WizardStep.ServerAddress);
  });

  it("one path and the demo still shows the choice", async () => {
    const rig = make(made({ offersOwnAi: false, offersDemo: true }));
    await rig.start();
    expect(rig.vm.step).toBe(WizardStep.Choose);
  });

  it("Back from the only path in Settings returns to Settings", async () => {
    const rig = make(made({ entry: WizardEntry.Settings, current: SERVER_CONNECTION, offersOwnAi: false }));
    await rig.start();
    await rig.press("connectOrganisation");
    await rig.press("back");
    expect(rig.vm.step).toBe(WizardStep.Settings);
  });

  it("Back from ServerAddress returns to the choice", async () => {
    const rig = make();
    await rig.start();
    await rig.press("chooseServer");
    await rig.press("back");
    expect(rig.vm.step).toBe(WizardStep.Choose);
  });

  it("a command that is not available does nothing when it is called anyway", async () => {
    const rig = make();
    await rig.start();
    await rig.vm.submitServer();
    rig.vm.cancel();
    rig.vm.signOut();
    expect(rig.vm.step).toBe(WizardStep.Choose);
  });
});

// ---- The machine policy ---------------------------------------------------------------------------------------------

describe("wizard: the machine policy", () => {
  const corp = () => policyOf({ server: new URL(CORP), standalone: PolicyAccess.Forbidden });

  it("a policy server opens path A with the address locked", async () => {
    const rig = make(made({ policy: corp(), offersDemo: true }));
    rig.sign.startScript.pending();
    await rig.start();
    expect(rig.vm.step).toBe(WizardStep.PairStarting);
    expect(rig.sign.started).toEqual([CORP]);
    expect(rig.vm.serverLocked).toBe(true);
    expect(rig.vm.canChooseDemo).toBe(false);
    expect(rig.vm.canChooseOwnAi).toBe(false);
    rig.vm.serverAddressText = "https://other.example.test";
    expect(rig.vm.serverAddressText).toBe(CORP);
  });

  it("a policy server cannot be changed from the code, and its address stays locked", async () => {
    const rig = make(made({ policy: corp() }));
    rig.sign.startScript.returns(makeTicket(rig.clock.now() + 600_000));
    await rig.start();
    expect(rig.vm.step).toBe(WizardStep.PairCode);
    unavailable(rig, "changeServer");
    rig.vm.cancel(); // back to the address: it shows the policy's server, locked
    expect(rig.vm.step).toBe(WizardStep.ServerAddress);
    expect(rig.vm.serverAddressText).toBe(CORP);
    rig.vm.serverAddressText = "https://other.example.test";
    expect(rig.vm.serverAddressText).toBe(CORP);
  });

  it("a policy server hides the change-server command at a failure", async () => {
    const rig = make(made({ policy: corp() }));
    rig.sign.startScript.throws(new FadenstackUnreachableError("down"));
    await rig.start();
    expect(rig.vm.step).toBe(WizardStep.StartFailed);
    unavailable(rig, "changeServer");
    expect(rig.vm.can.retry).toBe(true);
  });

  it("standalone forbidden hides own AI in Settings too", async () => {
    const rig = make(made({
      entry: WizardEntry.Settings, current: SERVER_CONNECTION, policy: policyOf({ standalone: PolicyAccess.Forbidden }),
    }));
    await rig.start();
    expect(rig.vm.canChooseOwnAi).toBe(false);
    unavailable(rig, "changeEndpoint");
    expect(rig.vm.can.connectOrganisation).toBe(true);
  });

  it("the endpoints list narrows the presets", () => {
    const rig = make(made({ policy: policyOf({ endpoints: ["http://localhost:11434"] }) }));
    // A preset with a base of its own stays only when the base is listed; one without (Azure, LiteLLM) has the person's
    // address, which the typed address is checked against.
    expect(rig.vm.presets.map((p) => p.id)).toEqual(["azure-openai", "ollama", "litellm"]);
  });

  it("the endpoints list narrows what the search found", async () => {
    const ollama: LocalEndpoint = { baseUrl: new URL("http://localhost:11434/v1"), preset: EndpointPreset.ollama };
    const lmStudio: LocalEndpoint = { baseUrl: new URL("http://localhost:1234/v1"), preset: EndpointPreset.lmStudio };
    const rig = await ownPick(made({ policy: policyOf({ endpoints: ["http://localhost:11434"] }), canSearchThisComputer: true }),
      (r) => r.checker.find.returns([ollama, lmStudio]), true);
    expect(rig.vm.step).toBe(WizardStep.OwnPick);
    expect(rig.vm.found).toEqual([ollama]);
  });

  it("a typed address the endpoints list does not have is not allowed", async () => {
    const rig = await ownPick(made({ policy: policyOf({ endpoints: ["http://localhost:11434"] }) }));
    type(rig, "https://api.other.example.test/v1");
    await useEndpoint(rig);
    expect(rig.vm.addressError).toBe(AddressProblem.NotAllowed);
    expect(rig.vm.step).toBe(WizardStep.OwnPick);
    expect(rig.checker.checked).toEqual([]);
  });

  it("a typed address the endpoints list has is checked", async () => {
    const rig = await ownPick(made({ policy: policyOf({ endpoints: ["https://api.example.test/v1"] }) }));
    type(rig, "https://api.example.test/v1");
    await useEndpoint(rig);
    expect(rig.vm.addressError).toBe(AddressProblem.None);
    expect(rig.vm.step).toBe(WizardStep.OwnResult);
  });

  it("plainHttp forbidden refuses http to the local network", async () => {
    const rig = await ownPick(made({ policy: policyOf({ plainHttp: PolicyAccess.Forbidden }) }),
      (r) => r.checker.places.set("192.168.1.20", EndpointPlace.LocalNetwork));
    type(rig, "http://192.168.1.20:11434/v1");
    await useEndpoint(rig);
    expect(rig.vm.addressError).toBe(AddressProblem.PlainHttpForbidden);
    expect(rig.vm.step).toBe(WizardStep.OwnPick);
    expect(rig.checker.checked).toEqual([]);
  });

  it("plainHttp forbidden refuses a key over http to this computer", async () => {
    const rig = await ownPick(made({ policy: policyOf({ plainHttp: PolicyAccess.Forbidden }) }));
    type(rig, "http://127.0.0.1:4000/v1");
    rig.vm.needsKey = true;
    await useEndpoint(rig);
    expect(rig.vm.addressError).toBe(AddressProblem.PlainHttpForbidden);
    expect(rig.vm.step).toBe(WizardStep.OwnPick);
  });

  it("plainHttp forbidden still allows http without a key to this computer", async () => {
    const rig = await ownPick(made({ policy: policyOf({ plainHttp: PolicyAccess.Forbidden }) }));
    await pick(rig, EndpointPreset.ollama);
    await useEndpoint(rig);
    expect(rig.vm.step).toBe(WizardStep.OwnResult);
    expect(rig.checker.checked).toHaveLength(1);
  });
});

// =====================================================================================================================
// §2 Path A
// =====================================================================================================================

describe("wizard: §2 path A", () => {
  it("ServerAddress goes to AppPrecondition on submit", async () => {
    const step = new FakeStep(WizardPoint.BeforeServerCheck);
    const running = step.script.pending();
    const rig = make(made({ steps: [step] }));
    await submitAddress(rig);
    expect(rig.vm.step).toBe(WizardStep.AppPrecondition);
    expect(rig.vm.appStep).toBe(step);
    expect(step.contexts).toHaveLength(1);
    expect(step.contexts[0]!.point).toBe(WizardPoint.BeforeServerCheck);
    expect(href(step.contexts[0]!.server)).toBe(ORG);
    expect(rig.sign.checked).toEqual([]);
    expect(running.isCompleted).toBe(false);
  });

  it("AppPrecondition goes back to ServerAddress when the permission is refused", async () => {
    const step = new FakeStep(WizardPoint.BeforeServerCheck);
    step.script.returns(false);
    const rig = make(made({ steps: [step] }));
    await submitAddress(rig);
    expect(rig.vm.step).toBe(WizardStep.ServerAddress);
    expect(rig.vm.appStepRefused).toBe(true);
    expect(rig.sign.checked).toEqual([]);
    expect(rig.vm.appStep).toBeUndefined();
  });

  it("AppPrecondition goes to Checking when the permission is granted", async () => {
    const step = new FakeStep(WizardPoint.BeforeServerCheck);
    const rig = make(made({ steps: [step] }));
    const check = rig.sign.checkScript.pending();
    await submitAddress(rig);
    rig.assertPassed(WizardStep.ServerAddress, WizardStep.AppPrecondition, WizardStep.Checking);
    expect(rig.vm.step).toBe(WizardStep.Checking);
    expect(rig.vm.appStepRefused).toBe(false);
    expect(rig.sign.checked).toEqual([ORG]);
    expect(check.isCompleted).toBe(false);
  });

  it("ServerAddress goes to Checking when there is no app step", async () => {
    const rig = make();
    rig.sign.checkScript.pending();
    await submitAddress(rig);
    expect(rig.vm.step).toBe(WizardStep.Checking);
    expect(rig.vm.isBusy).toBe(true);
    expect(rig.steps).not.toContain(WizardStep.AppPrecondition);
  });

  it("Checking goes back to ServerAddress on Cancel", async () => {
    const rig = make();
    rig.sign.checkScript.pending();
    await submitAddress(rig);
    await rig.press("cancel");
    expect(rig.vm.step).toBe(WizardStep.ServerAddress);
    expect(rig.store.servers).toEqual([]);
  });

  it.each([
    ["unreachable", new FadenstackUnreachableError("no answer"), WizardStep.Unreachable],
    ["certificate", new ServerCertificateError("not trusted"), WizardStep.CertificateNotTrusted],
    ["not_fadenstack", new FadenstackApiError(200, "a web page", { code: "not_fadenstack" }), WizardStep.NotFadenstack],
    ["redirect", new FadenstackApiError(302, "moved", { code: "redirect" }), WizardStep.NotFadenstack],
    ["other", new Error("odd"), WizardStep.NotFadenstack],
  ] as const)("Checking goes to the failure of the matching typed error (%s)", async (_, error, expected) => {
    const rig = make();
    rig.sign.checkScript.throws(error);
    await submitAddress(rig);
    expect(rig.vm.step).toBe(expected);
    expect(rig.store.servers).toEqual([]);
    expect(rig.sign.started).toEqual([]);
  });

  it("Checking goes back to ServerAddress when the health check says https is required", async () => {
    const rig = make();
    rig.sign.checkScript.throws(new FadenstackHttpsRequiredError("https needed"));
    await submitAddress(rig);
    expect(rig.vm.step).toBe(WizardStep.ServerAddress);
    expect(rig.vm.addressError).toBe(AddressProblem.HttpsRequired);
  });

  it("Checking goes to ServerAccepted and on to PairStarting when the server answers", async () => {
    const rig = make();
    const start = rig.sign.startScript.pending();
    await submitAddress(rig);
    rig.assertPassed(WizardStep.Checking, WizardStep.ServerAccepted, WizardStep.PairStarting);
    expect(rig.vm.step).toBe(WizardStep.PairStarting);
    expect(rig.store.servers).toEqual([ORG]); // saved before the pairing, so an app that restarts finds it
    expect(rig.sign.started).toEqual([ORG]);
    expect(start.isCompleted).toBe(false);
  });

  it("ServerAccepted goes to Finished (RestartOnServer) when the app restarts onto the new server", async () => {
    const rig = make(made({ restartsOnNewServer: true }));
    await submitAddress(rig);
    rig.assertPassed(WizardStep.Checking, WizardStep.ServerAccepted, WizardStep.Finished);
    expect(rig.vm.outcome).toBe(WizardOutcome.RestartOnServer);
    expect(rig.store.servers).toEqual([ORG]);
    expect(rig.sign.started).toEqual([]);
    expect(rig.store.saved).toEqual([]);
    expect(rig.completed).toEqual([WizardOutcome.RestartOnServer]);
  });

  it("Unreachable goes to Checking on Retry and on to the pairing when it answers", async () => {
    const rig = make();
    rig.sign.checkScript.throws(new FadenstackUnreachableError("no answer"));
    await submitAddress(rig);
    expect(rig.vm.step).toBe(WizardStep.Unreachable);
    const again = rig.sign.checkScript.pending();
    await rig.press("retry");
    expect(rig.vm.step).toBe(WizardStep.Checking);
    expect(rig.sign.checked).toHaveLength(2);
    again.complete();
    await flush();
    expect(rig.vm.step).toBe(WizardStep.PairCode);
  });

  it.each([
    ["unreachable", new FadenstackUnreachableError("no answer")],
    ["certificate", new ServerCertificateError("not trusted")],
    ["not_fadenstack", new FadenstackApiError(200, "a web page", { code: "not_fadenstack" })],
  ] as const)("a failed check (%s) goes to ServerAddress on ChangeServer", async (_, error) => {
    const rig = make();
    rig.sign.checkScript.throws(error);
    await submitAddress(rig);
    expect(rig.vm.step).not.toBe(WizardStep.ServerAddress);
    await rig.press("changeServer");
    expect(rig.vm.step).toBe(WizardStep.ServerAddress);
  });

  it("a certificate failure offers no retry with a click-through", async () => {
    const rig = make();
    rig.sign.checkScript.throws(new ServerCertificateError("not trusted"));
    await submitAddress(rig);
    expect(rig.vm.step).toBe(WizardStep.CertificateNotTrusted);
    unavailable(rig, "retry", "a CA comes only from the policy or the app's settings");
  });

  it("PairStarting goes to PairCode and shows the code and the page", async () => {
    const rig = make();
    const ticket = makeTicket(rig.clock.now() + 600_000);
    rig.sign.startScript.returns(ticket);
    await submitAddress(rig);
    rig.assertPassed(WizardStep.PairStarting, WizardStep.PairCode);
    expect(rig.vm.userCode).toBe("BDWP-HTQX");
    expect(rig.vm.pairingPage).toBe(ticket.verificationUriComplete);
    expect(rig.vm.timeLeftMs).toBe(600_000);
    expect(rig.sign.waited).toHaveLength(1);
    expect(rig.sign.waited[0]!.ticket).toBe(ticket);
  });

  it("PairStarting goes to ServerAddress on Cancel", async () => {
    const rig = make(made({ entry: WizardEntry.ServerKnown, server: new URL(ORG) }));
    rig.sign.startScript.pending();
    await rig.start();
    expect(rig.vm.step).toBe(WizardStep.PairStarting);
    await rig.press("cancel");
    expect(rig.vm.step).toBe(WizardStep.ServerAddress);
  });

  it.each([
    ["unreachable", new FadenstackUnreachableError("no answer"), StartFailure.Unreachable],
    ["certificate", new ServerCertificateError("not trusted"), StartFailure.CertificateNotTrusted],
    ["rate", new FadenstackRateLimitedError(429, "slow", undefined, undefined), StartFailure.RateLimited],
    ["elsewhere", new FadenstackPairingPageElsewhereError("page is elsewhere"), StartFailure.PageElsewhere],
    ["server", new FadenstackApiError(500, "oops"), StartFailure.ServerError],
    ["other", new Error("odd"), StartFailure.ServerError],
  ] as const)("PairStarting goes to StartFailed for each first-request failure (%s)", async (_, error, expected) => {
    const rig = make(made({ entry: WizardEntry.ServerKnown, server: new URL(ORG) }));
    rig.sign.startScript.throws(error);
    await rig.start();
    expect(rig.vm.step).toBe(WizardStep.StartFailed);
    expect(rig.vm.startFailure).toBe(expected);
    expect(rig.vm.retryAt !== undefined).toBe(expected === StartFailure.RateLimited);
  });

  it("a rate limit with Retry-After holds Retry back until the clock passes it", async () => {
    const rig = make(made({ entry: WizardEntry.ServerKnown, server: new URL(ORG) }));
    rig.sign.startScript.throws(new FadenstackRateLimitedError(429, "slow", undefined, 30_000));
    const started = rig.clock.now();
    await rig.start();
    let changes = 0;
    rig.vm.subscribe(() => changes++);
    expect(rig.vm.retryAt).toBe(started + 30_000);
    unavailable(rig, "retry");
    await rig.advance(29_000);
    unavailable(rig, "retry");
    await rig.advance(1000);
    expect(rig.vm.can.retry).toBe(true);
    expect(changes, "the skin is told when Retry becomes available").toBeGreaterThan(0);
  });

  it("a rate limit without Retry-After waits a minute", async () => {
    const rig = make(made({ entry: WizardEntry.ServerKnown, server: new URL(ORG) }));
    rig.sign.startScript.throws(new FadenstackRateLimitedError(429, "slow", undefined, undefined));
    const started = rig.clock.now();
    await rig.start();
    expect(rig.vm.retryAt).toBe(started + 60_000);
  });

  it("StartFailed goes to PairStarting on Retry", async () => {
    const rig = make(made({ entry: WizardEntry.ServerKnown, server: new URL(ORG) }));
    rig.sign.startScript.throws(new FadenstackUnreachableError("no answer"));
    await rig.start();
    const again = rig.sign.startScript.pending();
    await rig.press("retry");
    expect(rig.vm.step).toBe(WizardStep.PairStarting);
    expect(rig.vm.startFailure).toBeUndefined();
    expect(rig.sign.started).toHaveLength(2);
    again.complete(makeTicket(rig.clock.now() + 600_000));
    await flush();
    expect(rig.vm.step).toBe(WizardStep.PairCode);
  });

  it("StartFailed goes to ServerAddress on ChangeServer", async () => {
    const rig = make(made({ entry: WizardEntry.ServerKnown, server: new URL(ORG) }));
    rig.sign.startScript.throws(new FadenstackUnreachableError("no answer"));
    await rig.start();
    await rig.press("changeServer");
    expect(rig.vm.step).toBe(WizardStep.ServerAddress);
  });

  it("PairStarting goes to ServerTooOld when the server has no pairing", async () => {
    const rig = make(made({ entry: WizardEntry.ServerKnown, server: new URL(ORG) }));
    rig.sign.startScript.throws(new FadenstackPairingUnsupportedError("too old"));
    await rig.start();
    expect(rig.vm.step).toBe(WizardStep.ServerTooOld);
    expect(rig.vm.startFailure).toBeUndefined();
  });

  it("ServerTooOld goes to Password only with the password fallback", async () => {
    const rig = make(made({ entry: WizardEntry.ServerKnown, server: new URL(ORG), passwordFallback: true }));
    rig.sign.startScript.throws(new FadenstackPairingUnsupportedError("too old"));
    await rig.start();
    await rig.press("usePassword");
    expect(rig.vm.step).toBe(WizardStep.Password);
  });

  it("ServerTooOld offers no password without the fallback", async () => {
    const rig = make(made({ entry: WizardEntry.ServerKnown, server: new URL(ORG) }));
    rig.sign.startScript.throws(new FadenstackPairingUnsupportedError("too old"));
    await rig.start();
    unavailable(rig, "usePassword");
    expect(rig.vm.passwordFallback).toBe(false);
  });

  it("ServerTooOld goes to ServerAddress on ChangeServer", async () => {
    const rig = make(made({ entry: WizardEntry.ServerKnown, server: new URL(ORG) }));
    rig.sign.startScript.throws(new FadenstackPairingUnsupportedError("too old"));
    await rig.start();
    await rig.press("changeServer");
    expect(rig.vm.step).toBe(WizardStep.ServerAddress);
  });

  it("PairCode goes through Approved, Redeeming, SignedIn and AfterConnect to Finished (Connected)", async () => {
    let wait!: PendingAnswer<PairingApproval>;
    const step = new FakeStep(WizardPoint.AfterConnect);
    const rig = await pairCode(made({ steps: [step] }), (r) => { wait = r.sign.waitScript.pending(); });
    wait.complete(approve("main-agent"));
    await flush();
    rig.assertPassed(WizardStep.PairCode, WizardStep.Approved, WizardStep.Redeeming, WizardStep.SignedIn);
    expect(rig.vm.step).toBe(WizardStep.SignedIn);
    expect(rig.vm.person).toEqual(ANA);
    expect(rig.vm.agents).toEqual([approved("main-agent")]);
    expect(rig.store.saved).toEqual([]); // "Signed in as ..." shows first
    await rig.advance(PAUSE - 1);
    expect(rig.vm.step).toBe(WizardStep.SignedIn);
    await rig.advance(1);
    rig.assertPassed(WizardStep.SignedIn, WizardStep.AfterConnect, WizardStep.Finished);
    expect(rig.vm.outcome).toBe(WizardOutcome.Connected);
    expect(rig.store.saved).toHaveLength(1);
    const saved = rig.store.saved[0]!;
    expect(rig.vm.result).toBe(saved);
    expect(saved.mode).toBe(ConnectionMode.Server);
    expect(href(saved.server)).toBe(ORG);
    expect(saved.person).toEqual(ANA);
    expect(saved.agents).toEqual([approved("main-agent")]);
    expect(rig.completed).toEqual([WizardOutcome.Connected]);
  });

  it.each([
    ["denied", new FadenstackPairingDeniedError("denied"), WizardStep.Denied],
    ["expired", new FadenstackPairingExpiredError("expired"), WizardStep.Expired],
    ["failed", new FadenstackApiError(500, "oops"), WizardStep.PairFailed],
  ] as const)("PairCode goes to Denied, Expired or PairFailed when the wait ends so (%s)", async (_, error, expected) => {
    let wait!: PendingAnswer<PairingApproval>;
    const rig = await pairCode(undefined, (r) => { wait = r.sign.waitScript.pending(); });
    wait.fail(error);
    await flush();
    expect(rig.vm.step).toBe(expected);
    expect(rig.clock.activeTimers).toBe(0); // the countdown stops
    expect(rig.vm.isRetrying).toBe(false);
  });

  it("PairCode goes to Password when the person chooses a password", async () => {
    const rig = await pairCode(made({ passwordFallback: true }));
    await rig.press("usePassword");
    expect(rig.vm.step).toBe(WizardStep.Password);
    expect(rig.sign.waited[0]!.signal.aborted, "the wait for the approval stops").toBe(true);
    expect(rig.vm.userCode).toBeUndefined();
    expect(rig.clock.activeTimers).toBe(0);
  });

  it("PairCode offers no password without the fallback", async () => {
    const rig = await pairCode();
    unavailable(rig, "usePassword");
  });

  it("PairCode goes to ServerAddress on Cancel", async () => {
    const rig = await pairCode();
    await rig.press("cancel");
    expect(rig.vm.step).toBe(WizardStep.ServerAddress);
    expect(rig.sign.waited[0]!.signal.aborted).toBe(true);
    expect(rig.vm.userCode).toBeUndefined();
    expect(rig.clock.activeTimers).toBe(0);
  });

  it("PairCode goes to ServerAddress on ChangeServer", async () => {
    const rig = await pairCode();
    await rig.press("changeServer");
    expect(rig.vm.step).toBe(WizardStep.ServerAddress);
  });

  it("the countdown ticks each second and at zero the wizard goes to Expired by itself", async () => {
    const rig = make();
    rig.sign.startScript.returns(makeTicket(rig.clock.now() + 5000));
    const late = rig.sign.waitScript.pending(false);
    await submitAddress(rig);
    expect(rig.vm.timeLeftMs).toBe(5000);
    for (let left = 4; left >= 1; left--) {
      await rig.advance(1000);
      expect(rig.vm.timeLeftMs).toBe(left * 1000);
      expect(rig.vm.step).toBe(WizardStep.PairCode);
    }
    await rig.advance(1000);
    expect(rig.vm.step).toBe(WizardStep.Expired);
    expect(rig.sign.waited[0]!.signal.aborted, "the wait stops").toBe(true);
    expect(rig.vm.userCode).toBeUndefined();
    expect(rig.clock.activeTimers).toBe(0);
    late.complete(approve("main-agent")); // an approval that comes too late changes nothing
    await flush();
    expect(rig.vm.step).toBe(WizardStep.Expired);
  });

  it("the retrying banner follows the wait's progress", async () => {
    const rig = await pairCode();
    const onRetrying = rig.sign.waited[0]!.onRetrying;
    onRetrying(true);
    expect(rig.vm.isRetrying).toBe(true);
    onRetrying(false);
    expect(rig.vm.isRetrying).toBe(false);
  });

  it.each([
    ["denied", WizardStep.Denied, new FadenstackPairingDeniedError("denied")],
    ["expired", WizardStep.Expired, new FadenstackPairingExpiredError("expired")],
  ] as const)("%s goes to PairStarting on NewCode", async (_, from, error) => {
    let wait!: PendingAnswer<PairingApproval>;
    const rig = await pairCode(undefined, (r) => { wait = r.sign.waitScript.pending(); });
    wait.fail(error);
    await flush();
    expect(rig.vm.step).toBe(from);
    rig.sign.startScript.returns(makeTicket(rig.clock.now() + 600_000, "NEW1-CODE"));
    await rig.press("newCode");
    rig.assertPassed(from, WizardStep.PairStarting, WizardStep.PairCode);
    expect(rig.vm.userCode).toBe("NEW1-CODE");
    expect(rig.sign.started).toHaveLength(2);
  });

  it("NewCode is not available at the code", async () => {
    const rig = await pairCode();
    unavailable(rig, "newCode");
  });

  it("PairFailed goes to PairStarting on Retry", async () => {
    let wait!: PendingAnswer<PairingApproval>;
    const rig = await pairCode(undefined, (r) => { wait = r.sign.waitScript.pending(); });
    wait.fail(new FadenstackApiError(500, "oops"));
    await flush();
    expect(rig.vm.step).toBe(WizardStep.PairFailed);
    rig.sign.startScript.returns(makeTicket(rig.clock.now() + 600_000, "NEW1-CODE"));
    await rig.press("retry");
    expect(rig.vm.step).toBe(WizardStep.PairCode);
    expect(rig.vm.userCode).toBe("NEW1-CODE");
  });

  it("PairFailed goes to ServerAddress on ChangeServer", async () => {
    let wait!: PendingAnswer<PairingApproval>;
    const rig = await pairCode(undefined, (r) => { wait = r.sign.waitScript.pending(); });
    wait.fail(new FadenstackApiError(500, "oops"));
    await flush();
    await rig.press("changeServer");
    expect(rig.vm.step).toBe(WizardStep.ServerAddress);
  });
});

// ---- Several agents ------------------------------------------------------------------------------------------------

const SUITE = ["word", "excel", "outlook"];

async function suitePairCode(required: string[] = [], before?: (rig: WizardRig) => void): Promise<{ rig: WizardRig; wait: PendingAnswer<PairingApproval> }> {
  let wait!: PendingAnswer<PairingApproval>;
  const rig = await pairCode(made({ agents: SUITE, requiredAgents: required }), (r) => {
    wait = r.sign.waitScript.pending();
    r.sign.startScript.returns(makeTicket(r.clock.now() + 600_000, "BDWP-HTQX", ...SUITE));
    before?.(r);
  });
  return { rig, wait };
}

describe("wizard: several agents", () => {
  it("Redeeming collects every agent of the ticket not yet collected", async () => {
    const { rig, wait } = await suitePairCode();
    wait.complete(approve("word"));
    await flush();
    expect(rig.sign.redeemed).toEqual(["excel", "outlook"]);
    expect(rig.vm.step).toBe(WizardStep.SignedIn);
    expect(rig.vm.agents.map((a) => a.agent)).toEqual(SUITE);
    expect(rig.vm.agents.every((a) => a.access === AgentAccess.Approved)).toBe(true);
  });

  it("a refused agent that is not required still signs in", async () => {
    const { rig, wait } = await suitePairCode([], (r) => r.sign.redeemScript.returns(refused("excel")));
    wait.complete(approve("word"));
    await flush();
    expect(rig.vm.step).toBe(WizardStep.SignedIn);
    expect(rig.vm.agents.find((a) => a.agent === "excel")!.access).toBe(AgentAccess.Refused);
    expect(rig.vm.agents.find((a) => a.agent === "outlook")!.access).toBe(AgentAccess.Approved);
  });

  it("Redeeming goes to NoAccess when a required agent is refused", async () => {
    const { rig, wait } = await suitePairCode(["excel"], (r) => r.sign.redeemScript.returns(refused("excel")));
    wait.complete(approve("word"));
    await flush();
    rig.assertPassed(WizardStep.Redeeming, WizardStep.NoAccess);
    expect(rig.vm.step).toBe(WizardStep.NoAccess);
    expect(rig.store.saved).toEqual([]);
    expect(rig.vm.result).toBeUndefined();
  });

  it("Redeeming goes to NoAccess when the main agent is not approved", async () => {
    const { rig, wait } = await suitePairCode();
    wait.complete({ person: undefined, agents: [refused("word"), approved("excel")] });
    await flush();
    expect(rig.vm.step).toBe(WizardStep.NoAccess);
    expect(rig.sign.redeemed).toEqual(["outlook"]); // the ones the approval did not name are still collected
  });

  it("Redeeming goes to PairFailed when collecting an agent fails", async () => {
    const { rig, wait } = await suitePairCode([], (r) => r.sign.redeemScript.throws(new FadenstackUnreachableError("no answer")));
    wait.complete(approve("word"));
    await flush();
    expect(rig.vm.step).toBe(WizardStep.PairFailed);
  });

  it("NoAccess goes to ServerAddress on ChangeServer and to Finished (Closed) on Close", async () => {
    const first = await suitePairCode();
    first.wait.complete({ person: undefined, agents: [refused("word")] });
    await flush();
    expect(first.rig.vm.step).toBe(WizardStep.NoAccess);
    await first.rig.press("changeServer");
    expect(first.rig.vm.step).toBe(WizardStep.ServerAddress);

    const other = await suitePairCode();
    other.wait.complete({ person: undefined, agents: [refused("word")] });
    await flush();
    await other.rig.press("close");
    expect(other.rig.vm.step).toBe(WizardStep.Finished);
    expect(other.rig.vm.outcome).toBe(WizardOutcome.Closed);
  });
});

// ---- The password path ---------------------------------------------------------------------------------------------

async function passwordStep(before?: (rig: WizardRig) => void): Promise<WizardRig> {
  const rig = await pairCode(made({ passwordFallback: true }), before);
  await rig.press("usePassword");
  expect(rig.vm.step).toBe(WizardStep.Password);
  return rig;
}

describe("wizard: the password path", () => {
  it("Password goes to SignedIn and on to Finished (Connected)", async () => {
    const rig = await passwordStep((r) => r.sign.passwordScript.returns(approve("main-agent")));
    rig.vm.email = "  ana@example.test ";
    await rig.press("signInWithPassword", "correct horse");
    expect(rig.vm.step).toBe(WizardStep.SignedIn);
    expect(rig.sign.passwordsTried).toEqual([{ server: ORG, email: "ana@example.test", password: "correct horse" }]);
    expect(rig.vm.isBusy).toBe(false);
    await rig.advance(PAUSE);
    expect(rig.vm.outcome).toBe(WizardOutcome.Connected);
    expect(rig.store.saved).toHaveLength(1);
    expect(href(rig.store.saved[0]!.server)).toBe(ORG);
  });

  it("Password goes to NoAccess when a required agent is refused", async () => {
    const rig = await passwordStep((r) => r.sign.passwordScript.returns({ person: undefined, agents: [refused("main-agent")] }));
    rig.vm.email = "ana@example.test";
    await rig.press("signInWithPassword", "pw");
    expect(rig.vm.step).toBe(WizardStep.NoAccess);
  });

  it("Password stays when the e-mail or the password is empty", async () => {
    const rig = await passwordStep();
    rig.vm.email = "";
    await rig.press("signInWithPassword", "pw");
    rig.vm.email = "ana@example.test";
    await rig.press("signInWithPassword", "");
    await rig.press("signInWithPassword", null);
    expect(rig.vm.step).toBe(WizardStep.Password);
    expect(rig.sign.passwordsTried).toEqual([]);
  });

  it.each([
    ["bad", new FadenstackBadCredentialsError(), PasswordFailure.BadCredentials],
    ["https", new FadenstackHttpsRequiredError("https needed"), PasswordFailure.HttpsRequired],
    ["not_fadenstack", new FadenstackApiError(200, "a web page", { code: "not_fadenstack" }), PasswordFailure.NotFadenstack],
    ["redirect", new FadenstackApiError(302, "moved", { code: "redirect" }), PasswordFailure.NotFadenstack],
    ["unreachable", new FadenstackUnreachableError("no answer"), PasswordFailure.Unreachable],
    ["certificate", new ServerCertificateError("not trusted"), PasswordFailure.CertificateNotTrusted],
    ["other", new Error("odd"), PasswordFailure.Other],
  ] as const)("Password goes to PasswordError for each typed error (%s)", async (_, error, expected) => {
    const rig = await passwordStep((r) => r.sign.passwordScript.throws(error));
    rig.vm.email = "ana@example.test";
    await rig.press("signInWithPassword", "pw");
    expect(rig.vm.step).toBe(WizardStep.PasswordError);
    expect(rig.vm.passwordFailure).toBe(expected);
    expect(rig.vm.isBusy).toBe(false);
  });

  it("PasswordError goes to Password on Retry", async () => {
    const rig = await passwordStep((r) => r.sign.passwordScript.throws(new FadenstackBadCredentialsError()));
    rig.vm.email = "ana@example.test";
    await rig.press("signInWithPassword", "pw");
    await rig.press("retry");
    expect(rig.vm.step).toBe(WizardStep.Password);
    expect(rig.vm.passwordFailure).toBeUndefined();
  });

  it("Password goes to PairStarting on BackToCode", async () => {
    const rig = await passwordStep();
    rig.sign.startScript.returns(makeTicket(rig.clock.now() + 600_000, "NEW1-CODE"));
    await rig.press("backToCode");
    rig.assertPassed(WizardStep.Password, WizardStep.PairStarting, WizardStep.PairCode);
    expect(rig.vm.userCode).toBe("NEW1-CODE");
  });

  it("PasswordError goes to PairStarting on BackToCode", async () => {
    const rig = await passwordStep((r) => r.sign.passwordScript.throws(new FadenstackBadCredentialsError()));
    rig.vm.email = "ana@example.test";
    await rig.press("signInWithPassword", "pw");
    rig.sign.startScript.returns(makeTicket(rig.clock.now() + 600_000, "NEW1-CODE"));
    await rig.press("backToCode");
    expect(rig.vm.step).toBe(WizardStep.PairCode);
  });

  it("a password sign-in is busy while it runs and Cancel stops it", async () => {
    let login!: PendingAnswer<PairingApproval>;
    const rig = await passwordStep((r) => { login = r.sign.passwordScript.pending(false); });
    rig.vm.email = "ana@example.test";
    await rig.press("signInWithPassword", "pw");
    expect(rig.vm.isBusy).toBe(true);
    unavailable(rig, "signInWithPassword");
    unavailable(rig, "backToCode");
    await rig.press("cancel");
    expect(rig.vm.isBusy).toBe(false);
    expect(rig.vm.step).toBe(WizardStep.Password);
    login.complete(approve("main-agent")); // the answer comes late: stale
    await flush();
    expect(rig.vm.step).toBe(WizardStep.Password);
    expect(rig.store.saved).toEqual([]);
  });
});

// ---- The pairing page and the clipboard ----------------------------------------------------------------------------

describe("wizard: the pairing page and the clipboard", () => {
  it("OpenPairingPage opens the page through the link opener", async () => {
    const rig = await pairCode();
    await rig.press("openPairingPage");
    expect(rig.links.opened).toEqual(["https://ai.example.test/pair?code=BDWP-HTQX"]);
  });

  it("CopyCode puts the user code on the clipboard", async () => {
    const rig = await pairCode();
    await rig.press("copyCode");
    expect(rig.clipboard.texts).toEqual(["BDWP-HTQX"]);
  });

  it("the page and the clipboard are available only at the code", async () => {
    const rig = make();
    await rig.start();
    unavailable(rig, "openPairingPage");
    unavailable(rig, "copyCode");
  });
});

// ---- The address rule ----------------------------------------------------------------------------------------------

describe("wizard: the address rule", () => {
  it.each([
    ["https://ai.example.test/faden/", "https://ai.example.test/faden/"],
    ["https://ai.example.test/faden", "https://ai.example.test/faden"],
    ["https://ai.example.test/faden/?x=1&y=2", "https://ai.example.test/faden/"],
    ["https://ai.example.test/faden/#section", "https://ai.example.test/faden/"],
    ["https://ai.example.test:8443/?token=abc#frag", "https://ai.example.test:8443/"],
    ["ai.example.test", "https://ai.example.test/"],
    ["ai.example.test:8443/faden", "https://ai.example.test:8443/faden"],
    ["  https://ai.example.test  ", "https://ai.example.test/"],
    ["http://localhost:8000", "http://localhost:8000/"],
    ["http://127.0.0.1:8000/faden/", "http://127.0.0.1:8000/faden/"],
    ["http://[::1]:8000", "http://[::1]:8000/"],
  ])("keeps scheme, host, port and path and drops query and fragment: %s", (typed, kept) => {
    const { server, problem } = make().vm.parseServer(typed);
    expect(server?.href).toBe(kept);
    expect(problem).toBe(AddressProblem.None);
  });

  it.each([
    "", "   ", "https://anna:secret@ai.example.test", "https://anna@ai.example.test/", "ftp://ai.example.test", "file:///etc/passwd",
    "javascript:alert(1)", "https://", "not a host name",
  ])("refuses user info, other schemes and nonsense: %j", (typed) => {
    const { server, problem } = make().vm.parseServer(typed);
    expect(server).toBeUndefined();
    expect(problem).toBe(AddressProblem.Invalid);
  });

  it.each(["http://ai.example.test", "http://192.168.1.20:8000", "http://ai.example.test/faden/"])(
    "refuses plain http to another machine: %s", (typed) => {
      const { server, problem } = make().vm.parseServer(typed);
      expect(server).toBeUndefined();
      expect(problem).toBe(AddressProblem.HttpsRequired);
    });

  it.each([
    ["http://corp.internal:8080/faden", true],
    ["http://corp.internal:8080/faden/", true],
    ["HTTP://CORP.internal:8080/faden", true],
    ["http://corp.internal:8080/other", false],
    ["http://other.internal:8080/faden", false],
  ])("takes plain http only to the http server a machine policy names: %s", (typed, taken) => {
    const policy = policyOf({ server: new URL("http://corp.internal:8080/faden"), standalone: PolicyAccess.Forbidden });
    const { server, problem } = make(made({ policy })).vm.parseServer(typed);
    expect(server !== undefined).toBe(taken);
    expect(problem).toBe(taken ? AddressProblem.None : AddressProblem.HttpsRequired);
  });

  it("submitting a bad address says why and nothing runs", async () => {
    const step = new FakeStep(WizardPoint.BeforeServerCheck);
    const rig = make(made({ steps: [step] }));
    await rig.start();
    await rig.press("chooseServer");
    rig.vm.serverAddressText = "http://ai.example.test";
    await rig.press("submitServer");
    expect(rig.vm.addressError).toBe(AddressProblem.HttpsRequired);
    expect(rig.vm.step).toBe(WizardStep.ServerAddress);
    rig.vm.serverAddressText = "ftp://x.test"; // typing again clears the old message
    expect(rig.vm.addressError).toBe(AddressProblem.None);
    await rig.press("submitServer");
    expect(rig.vm.addressError).toBe(AddressProblem.Invalid);
    expect(step.contexts).toEqual([]);
    expect(rig.sign.checked).toEqual([]);
  });
});

// =====================================================================================================================
// §3 Path B
// =====================================================================================================================

const LAN = "http://192.168.1.20:11434/v1";
const lanPlace = (rig: WizardRig): void => {
  rig.checker.places.set("192.168.1.20", EndpointPlace.LocalNetwork);
};
const OLLAMA = "http://localhost:11434/v1";

describe("wizard: §3 path B", () => {
  it("OwnAccept offers Accept only once the box is ticked and the box starts unticked", async () => {
    const rig = make();
    await rig.start();
    await rig.press("chooseOwnAi");
    expect(rig.vm.accepted).toBe(false);
    unavailable(rig, "accept");
    rig.vm.accepted = true;
    expect(rig.vm.can.accept).toBe(true);
    rig.vm.accepted = false;
    unavailable(rig, "accept");
    expect(rig.store.acceptances).toEqual([]);
  });

  it("OwnAccept goes to OwnPick, keeps the acceptance record and never searches without consent", async () => {
    const rig = make(made({ termsVersion: "2026-11-14" }));
    await rig.start();
    await rig.press("chooseOwnAi");
    rig.vm.accepted = true;
    const accepted = rig.clock.now();
    await rig.press("accept");
    expect(rig.vm.step).toBe(WizardStep.OwnPick);
    expect(rig.store.acceptances).toEqual([{ termsVersion: "2026-11-14", acceptedAt: accepted, language: "de", mode: "standalone" }]);
    expect(rig.checker.find.calls).toBe(0);
  });

  it("OwnAccept goes to OwnSearching and OwnPick with consent to search", async () => {
    const ollama: LocalEndpoint = { baseUrl: new URL("http://127.0.0.1:11434/v1"), preset: EndpointPreset.ollama, models: ["m1"] };
    let search!: PendingAnswer<readonly LocalEndpoint[]>;
    const rig = await ownPick(undefined, (r) => { search = r.checker.find.pending(); }, true);
    expect(rig.vm.step).toBe(WizardStep.OwnSearching);
    expect(rig.vm.isBusy).toBe(true);
    expect(rig.store.acceptances).toHaveLength(1);
    search.complete([ollama]);
    await flush();
    expect(rig.vm.step).toBe(WizardStep.OwnPick);
    expect(rig.vm.found).toEqual([ollama]);
    expect(rig.checker.find.calls).toBe(1);
  });

  it("a search that fails finds nothing and goes on to OwnPick", async () => {
    const rig = await ownPick(undefined, (r) => r.checker.find.throws(new Error("no sockets")), true);
    expect(rig.vm.step).toBe(WizardStep.OwnPick);
    expect(rig.vm.found).toEqual([]);
  });

  it("the search never runs when the app cannot search this computer", async () => {
    const rig = await ownPick(made({ canSearchThisComputer: false }), undefined, true);
    expect(rig.vm.step).toBe(WizardStep.OwnPick);
    expect(rig.vm.canSearchThisComputer).toBe(false);
    expect(rig.checker.find.calls).toBe(0);
  });

  it("OwnSearching goes to OwnPick on Cancel and the late answer changes nothing", async () => {
    let search!: PendingAnswer<readonly LocalEndpoint[]>;
    const rig = await ownPick(undefined, (r) => { search = r.checker.find.pending(false); }, true);
    await rig.press("cancel");
    search.complete([{ baseUrl: new URL("http://127.0.0.1:11434/v1") }]);
    await flush();
    expect(rig.vm.step).toBe(WizardStep.OwnPick);
    expect(rig.vm.found).toEqual([]);
  });

  it("OwnAccept goes to ServerAddress on ServerModeInstead", async () => {
    const rig = make();
    await rig.start();
    await rig.press("chooseOwnAi");
    await rig.press("serverModeInstead");
    expect(rig.vm.step).toBe(WizardStep.ServerAddress);
    expect(rig.store.acceptances).toEqual([]);
  });

  it("OwnAccept goes to Choose on Back and the boxes start unticked again", async () => {
    const rig = make();
    await rig.start();
    await rig.press("chooseOwnAi");
    rig.vm.accepted = true;
    rig.vm.searchConsent = true;
    await rig.press("back");
    expect(rig.vm.step).toBe(WizardStep.Choose);
    await rig.press("chooseOwnAi");
    expect(rig.vm.accepted).toBe(false);
    expect(rig.vm.searchConsent).toBe(false);
  });

  it("OwnPick offers what was found and the presets, and a pick fills the address", async () => {
    const found: LocalEndpoint = { baseUrl: new URL("http://127.0.0.1:1234/v1"), preset: EndpointPreset.lmStudio };
    const rig = await ownPick(undefined, (r) => r.checker.find.returns([found]), true);
    await rig.press("selectFound", found);
    expect(rig.vm.endpointAddressText).toBe("http://127.0.0.1:1234/v1");
    expect(rig.vm.selectedPreset).toBe(EndpointPreset.lmStudio);
    expect(rig.vm.needsKey).toBe(false);
    await pick(rig, EndpointPreset.openAi);
    expect(rig.vm.endpointAddressText).toBe("https://api.openai.com/v1");
    expect(rig.vm.needsKey).toBe(true);
    expect(rig.vm.presets).toHaveLength(EndpointPreset.all.length);
  });

  it("OwnPick goes to OwnPlainHttp for http to a local network address and ConfirmPlainHttp checks with no key", async () => {
    const rig = await ownPick(undefined, lanPlace);
    type(rig, LAN);
    await useEndpoint(rig);
    expect(rig.vm.step).toBe(WizardStep.OwnPlainHttp);
    expect(rig.checker.checked).toEqual([]);
    await rig.press("confirmPlainHttp");
    rig.assertPassed(WizardStep.OwnPlainHttp, WizardStep.OwnChecking, WizardStep.OwnResult); // BeforeCheck shows only when an app step runs
    expect(rig.checker.checked).toHaveLength(1);
    expect(rig.checker.checked[0]!.allowPlainHttpInLan).toBe(true);
    expect(rig.checker.checked[0]!.key).toBeUndefined();
    expect(rig.keys.saved).toEqual([]);
    expect(rig.vm.keySet).toBe(false);
  });

  it("OwnPlainHttp goes to OwnPick on Back", async () => {
    const rig = await ownPick(undefined, lanPlace);
    type(rig, LAN);
    await useEndpoint(rig);
    await rig.press("back");
    expect(rig.vm.step).toBe(WizardStep.OwnPick);
  });

  it("OwnPick goes to OwnKey when a key is needed", async () => {
    const rig = await ownPick();
    await pick(rig, EndpointPreset.openAi);
    await useEndpoint(rig);
    expect(rig.vm.step).toBe(WizardStep.OwnKey);
    expect(rig.checker.checked).toEqual([]);
    expect(rig.keys.saved).toEqual([]);
    expect(rig.checker.placeAsked, "https: no need to decide where it points").toEqual([]);
  });

  it("OwnPick goes through BeforeCheck to OwnChecking with no key", async () => {
    const step = new FakeStep(WizardPoint.BeforeEndpointCheck);
    const running = step.script.pending();
    let check!: PendingAnswer<ReturnType<typeof usableReport>>;
    const rig = await ownPick(made({ steps: [step] }), (r) => { check = r.checker.report.pending(); });
    await pick(rig, EndpointPreset.ollama);
    await useEndpoint(rig);
    expect(rig.vm.step).toBe(WizardStep.BeforeCheck);
    expect(rig.vm.appStep).toBe(step);
    expect(step.contexts).toHaveLength(1);
    expect(step.contexts[0]!.point).toBe(WizardPoint.BeforeEndpointCheck);
    expect(href(step.contexts[0]!.endpoint!.baseUrl)).toBe(OLLAMA);
    expect(step.contexts[0]!.endpoint!.key).toBeUndefined();
    expect(rig.checker.checked).toEqual([]);
    running.complete(true);
    await flush();
    expect(rig.vm.step).toBe(WizardStep.OwnChecking);
    expect(rig.checker.checked).toHaveLength(1);
    const endpoint = rig.checker.checked[0]!;
    expect(endpoint.key).toBeUndefined();
    expect(endpoint.allowPlainHttpInLan).toBe(false);
    expect(endpoint.model, "the check names the model; the person picks it afterwards").toBeUndefined();
    expect(endpoint.dialect).toBe(EndpointPreset.ollama.dialect);
    expect(check.isCompleted).toBe(false);
  });

  it("a key over plain http to this computer is allowed", async () => {
    const rig = await ownPick();
    type(rig, "http://127.0.0.1:4000/v1");
    rig.vm.needsKey = true;
    await useEndpoint(rig);
    expect(rig.vm.step).toBe(WizardStep.OwnKey);
    expect(rig.vm.addressError).toBe(AddressProblem.None);
    await rig.press("submitKey", "sk-local-1");
    expect(rig.vm.step).toBe(WizardStep.OwnResult);
    expect(rig.checker.checked).toHaveLength(1);
    expect(rig.checker.checked[0]!.allowPlainHttpInLan).toBe(false);
  });

  it("plain http to the internet is refused as HttpsRequired", async () => {
    const rig = await ownPick();
    type(rig, "http://8.8.8.8:11434/v1");
    await useEndpoint(rig);
    expect(rig.vm.addressError).toBe(AddressProblem.HttpsRequired);
    expect(rig.vm.step).toBe(WizardStep.OwnPick);
    expect(rig.checker.checked).toEqual([]);
  });

  it("a key over plain http to the local network is refused as KeyNeedsHttps", async () => {
    const rig = await ownPick(undefined, lanPlace);
    type(rig, "http://192.168.1.20:4000/v1");
    rig.vm.needsKey = true;
    await useEndpoint(rig);
    expect(rig.vm.addressError).toBe(AddressProblem.KeyNeedsHttps);
    expect(rig.vm.step).toBe(WizardStep.OwnPick);
    expect(rig.keys.saved).toEqual([]);
  });

  it.each(["", "localhost:11434", "ftp://x.test/v1", "https://anna:secret@api.example.test/v1"])(
    "a typed endpoint address that is no http address is Invalid: %j", async (typed) => {
      const rig = await ownPick();
      type(rig, typed);
      await useEndpoint(rig);
      expect(rig.vm.addressError).toBe(AddressProblem.Invalid);
      expect(rig.vm.step).toBe(WizardStep.OwnPick);
    });

  it("a typed endpoint address drops query and fragment", async () => {
    const rig = await ownPick();
    type(rig, "https://api.example.test/v1?api-version=1#x");
    await useEndpoint(rig);
    expect(href(rig.checker.checked[0]!.baseUrl)).toBe("https://api.example.test/v1");
  });

  it("OwnKey goes to BeforeCheck, hands the key to the key store and checks with its provider", async () => {
    const step = new FakeStep(WizardPoint.BeforeEndpointCheck);
    const rig = await ownPick(made({ steps: [step] }));
    await pick(rig, EndpointPreset.openAi);
    await useEndpoint(rig);
    await rig.press("submitKey", "  sk-test-1234  ");
    rig.assertPassed(WizardStep.OwnKey, WizardStep.BeforeCheck, WizardStep.OwnChecking, WizardStep.OwnResult);
    expect(rig.keys.saved).toEqual([{ endpoint: "https://api.openai.com/v1", key: "sk-test-1234" }]);
    expect(rig.vm.keySet).toBe(true);
    const provider = rig.keys.providers[0]!;
    expect(rig.checker.checked[0]!.key).toBe(provider);
    expect(step.contexts[0]!.endpoint!.key).toBe(provider);
    expect(await provider.getAccessToken()).toBe("sk-test-1234");
  });

  it("Cancel while the app's step before the check runs goes back to the pick, clears the step and checks nothing", async () => {
    const step = new FakeStep(WizardPoint.BeforeEndpointCheck);
    step.script.pending();
    const rig = await ownPick(made({ steps: [step] }));
    type(rig, "https://api.example.test/v1");
    void useEndpoint(rig);
    await flush();
    expect(rig.vm.step).toBe(WizardStep.BeforeCheck);
    expect(rig.vm.appStep).toBe(step);
    await rig.press("cancel");
    expect(rig.vm.step).toBe(WizardStep.OwnPick);
    expect(rig.vm.appStep).toBeUndefined();
    expect(rig.checker.checked).toEqual([]);
  });

  it("OwnKey ignores an empty key", async () => {
    const rig = await ownPick();
    await pick(rig, EndpointPreset.openAi);
    await useEndpoint(rig);
    await rig.press("submitKey", "   ");
    await rig.press("submitKey", null);
    expect(rig.vm.step).toBe(WizardStep.OwnKey);
    expect(rig.keys.saved).toEqual([]);
  });

  it("OwnKey goes to OwnPick on Back", async () => {
    const rig = await ownPick();
    await pick(rig, EndpointPreset.openAi);
    await useEndpoint(rig);
    await rig.press("back");
    expect(rig.vm.step).toBe(WizardStep.OwnPick);
  });

  it.each([["refused", false], ["throws", new Error("permission dialog failed")]] as const)(
    "BeforeCheck goes to OwnPick when the app's step %s", async (_, answer) => {
      const step = new FakeStep(WizardPoint.BeforeEndpointCheck);
      if (answer === false) step.script.returns(false);
      else step.script.throws(answer);
      const rig = await ownPick(made({ steps: [step] }));
      await pick(rig, EndpointPreset.ollama);
      await useEndpoint(rig);
      expect(rig.vm.step).toBe(WizardStep.OwnPick);
      expect(rig.vm.appStepRefused).toBe(true);
      expect(rig.checker.checked).toEqual([]);
    });

  it("OwnChecking goes to OwnPick on Cancel and the late report changes nothing", async () => {
    let check!: PendingAnswer<ReturnType<typeof usableReport>>;
    const rig = await ownPick(undefined, (r) => { check = r.checker.report.pending(false); });
    await pick(rig, EndpointPreset.ollama);
    await useEndpoint(rig);
    expect(rig.vm.step).toBe(WizardStep.OwnChecking);
    await rig.press("cancel");
    check.complete(usableReport(OLLAMA));
    await flush();
    expect(rig.vm.step).toBe(WizardStep.OwnPick);
    expect(rig.vm.report).toBeUndefined();
    expect(rig.vm.models).toEqual([]);
    expect(rig.vm.result).toBeUndefined();
  });

  it.each(["KeyRejected", "OriginRefused", "Unreachable", "CertificateNotTrusted", "NotCompatible", "PlainHttpRefused", "RateLimited", "ModelNotFound"] as const)(
    "OwnChecking goes to OwnFailed for the blocking problem %s", async (problem) => {
      const rig = await ownPick(undefined, (r) => r.checker.report.returns(failingReport(OLLAMA, problem)));
      await pick(rig, EndpointPreset.ollama);
      await useEndpoint(rig);
      expect(rig.vm.step).toBe(WizardStep.OwnFailed);
      expect(rig.vm.problem).toBe(problem);
      expect(rig.vm.report).toBeDefined();
      expect(rig.vm.result).toBeUndefined();
    });

  it("OwnFailed names the first blocking problem, the key before the unreachable", async () => {
    const rig = await ownPick(undefined, (r) => r.checker.report.returns(failingReport(OLLAMA, "NotCompatible", "Unreachable", "KeyRejected")));
    await pick(rig, EndpointPreset.ollama);
    await useEndpoint(rig);
    expect(rig.vm.problem).toBe("KeyRejected");
  });

  it("OwnFailed with only non-blocking problems is the general failure", async () => {
    const report = makeReport(OLLAMA, { chat: false, problems: ["NoToolCalls"] });
    const rig = await ownPick(undefined, (r) => r.checker.report.returns(report));
    await pick(rig, EndpointPreset.ollama);
    await useEndpoint(rig);
    expect(rig.vm.step).toBe(WizardStep.OwnFailed);
    expect(rig.vm.problem).toBe("Failed");
  });

  it("OwnChecking goes to OwnFailed when the check itself throws", async () => {
    const rig = await ownPick(undefined, (r) => r.checker.report.throws(new Error("boom")));
    await pick(rig, EndpointPreset.ollama);
    await useEndpoint(rig);
    expect(rig.vm.step).toBe(WizardStep.OwnFailed);
    expect(rig.vm.problem).toBe("Failed");
  });

  it("OwnFailed goes to OwnKey on EnterKey when the key was rejected and the new key is checked", async () => {
    const rig = await ownPick(undefined, (r) => r.checker.report.returns(failingReport("https://api.openai.com/v1", "KeyRejected")));
    await pick(rig, EndpointPreset.openAi);
    await useEndpoint(rig);
    await rig.press("submitKey", "sk-wrong");
    expect(rig.vm.step).toBe(WizardStep.OwnFailed);
    await rig.press("enterKey");
    expect(rig.vm.step).toBe(WizardStep.OwnKey);
    await rig.press("submitKey", "sk-right");
    expect(rig.vm.step).toBe(WizardStep.OwnResult);
    expect(rig.keys.saved.map((s) => s.key)).toEqual(["sk-wrong", "sk-right"]);
    expect(rig.checker.checked[1]!.key).toBe(rig.keys.providers[1]);
  });

  it("EnterKey is not offered for plain http to the local network or for other problems", async () => {
    const rig = await ownPick(undefined, (r) => {
      lanPlace(r);
      r.checker.report.returns(failingReport(LAN, "KeyRejected"));
    });
    type(rig, LAN);
    await useEndpoint(rig);
    await rig.press("confirmPlainHttp");
    expect(rig.vm.step).toBe(WizardStep.OwnFailed);
    expect(rig.vm.problem).toBe("KeyRejected");
    unavailable(rig, "enterKey", "never a key over plain http to the network (D3)");

    const other = await ownPick(undefined, (r) => r.checker.report.returns(failingReport(OLLAMA, "Unreachable")));
    await pick(other, EndpointPreset.ollama);
    await useEndpoint(other);
    unavailable(other, "enterKey");
    unavailable(other, "showHelp");
  });

  it("OwnFailed goes to OwnHelp on ShowHelp when the origin is refused and OwnHelp goes to OwnChecking on Retry", async () => {
    const rig = await ownPick(undefined, (r) => r.checker.report.returns(failingReport(OLLAMA, "OriginRefused")));
    await pick(rig, EndpointPreset.ollama);
    await useEndpoint(rig);
    unavailable(rig, "enterKey");
    await rig.press("showHelp");
    expect(rig.vm.step).toBe(WizardStep.OwnHelp);
    await rig.press("retry");
    expect(rig.vm.step).toBe(WizardStep.OwnResult); // the second check passes
    expect(rig.checker.checked).toHaveLength(2);
    rig.assertPassed(WizardStep.OwnHelp, WizardStep.OwnChecking, WizardStep.OwnResult);
  });

  it("OwnFailed goes to OwnChecking on Retry", async () => {
    const rig = await ownPick(undefined, (r) => r.checker.report.returns(failingReport(OLLAMA, "Unreachable")));
    await pick(rig, EndpointPreset.ollama);
    await useEndpoint(rig);
    const again = rig.checker.report.pending();
    await rig.press("retry");
    expect(rig.vm.step).toBe(WizardStep.OwnChecking);
    expect(rig.checker.checked).toHaveLength(2);
    expect(again.isCompleted).toBe(false);
  });

  it("OwnFailed goes to OwnPick on Back", async () => {
    const rig = await ownPick(undefined, (r) => r.checker.report.returns(failingReport(OLLAMA, "Unreachable")));
    await pick(rig, EndpointPreset.ollama);
    await useEndpoint(rig);
    await rig.press("back");
    expect(rig.vm.step).toBe(WizardStep.OwnPick);
  });

  it("OwnChecking goes to OwnResult and shows what the check found", async () => {
    const report = usableReport(OLLAMA, "m1", "m1", "m2");
    const rig = await ownPick(undefined, (r) => r.checker.report.returns(report));
    await pick(rig, EndpointPreset.ollama);
    await useEndpoint(rig);
    expect(rig.vm.step).toBe(WizardStep.OwnResult);
    expect(rig.vm.report).toBe(report);
    expect(rig.vm.models).toEqual(["m1", "m2"]);
    expect(rig.vm.selectedModel).toBe("m1");
    expect(rig.vm.problem).toBeUndefined();
  });

  it("OwnResult goes to OwnPick on Back", async () => {
    const rig = await ownPick();
    await pick(rig, EndpointPreset.ollama);
    await useEndpoint(rig);
    await rig.press("back");
    expect(rig.vm.step).toBe(WizardStep.OwnPick);
  });

  it("OwnResult goes to OwnModel when the server lists several models, also chat only", async () => {
    const chatOnly = makeReport(OLLAMA, { model: "m1", models: ["m1", "m2"], toolCalls: false, problems: ["NoToolCalls"] });
    const rig = await ownPick(undefined, (r) => r.checker.report.returns(chatOnly));
    await pick(rig, EndpointPreset.ollama);
    await useEndpoint(rig);
    expect(rig.vm.report!.chatOnly).toBe(true);
    await rig.press("continue");
    expect(rig.vm.step).toBe(WizardStep.OwnModel);
    expect(rig.store.saved).toEqual([]);
  });

  it("OwnResult goes through OwnDone and AfterConnect to Finished (Connected) when there is one model", async () => {
    const step = new FakeStep(WizardPoint.AfterConnect);
    const rig = await ownPick(made({ steps: [step] }));
    await pick(rig, EndpointPreset.ollama);
    await useEndpoint(rig);
    await rig.press("continue");
    rig.assertPassed(WizardStep.OwnResult, WizardStep.OwnDone, WizardStep.AfterConnect, WizardStep.Finished);
    expect(rig.vm.outcome).toBe(WizardOutcome.Connected);
    expect(rig.store.saved).toHaveLength(1);
    const saved = rig.store.saved[0]!;
    expect(rig.vm.result).toBe(saved);
    expect(saved.mode).toBe(ConnectionMode.Endpoint);
    expect(saved.endpoint!.model).toBe("m1");
    expect(href(saved.endpoint!.baseUrl)).toBe(OLLAMA);
    expect(saved.presetId).toBe("ollama");
    expect(saved.report).toBe(rig.vm.report);
    expect(saved.endpoint!.key).toBeUndefined();
    expect(step.contexts[0]!.result).toBe(saved);
    expect(rig.completed).toEqual([WizardOutcome.Connected]);
  });

  async function modelStep(): Promise<{ rig: WizardRig; first: ReturnType<typeof usableReport> }> {
    const first = usableReport("https://api.openai.com/v1", "m1", "m1", "m2");
    const rig = await ownPick(undefined, (r) => r.checker.report.returns(first));
    await pick(rig, EndpointPreset.openAi);
    await useEndpoint(rig);
    await rig.press("submitKey", "sk-test-1234");
    await rig.press("continue");
    expect(rig.vm.step).toBe(WizardStep.OwnModel);
    return { rig, first };
  }

  it("OwnModel with the model that was checked finishes without a second check", async () => {
    const { rig, first } = await modelStep();
    expect(rig.vm.selectedModel).toBe("m1");
    await rig.press("continue");
    expect(rig.vm.outcome).toBe(WizardOutcome.Connected);
    expect(rig.checker.checked).toHaveLength(1);
    const saved = rig.store.saved[0]!;
    expect(saved.endpoint!.model).toBe("m1");
    expect(saved.report).toBe(first);
    expect(saved.endpoint!.key).toBe(rig.keys.providers[0]);
    expect(saved.presetId).toBe("openai");
  });

  it("OwnModel checks another model again before it is taken", async () => {
    const { rig } = await modelStep();
    const second = usableReport("https://api.openai.com/v1", "m2", "m1", "m2");
    rig.checker.report.returns(second);
    rig.vm.selectedModel = "m2";
    await rig.press("continue");
    expect(rig.vm.step).toBe(WizardStep.OwnResult);
    expect(rig.checker.checked.map((e) => e.model)).toEqual([undefined, "m2"]);
    expect(rig.checker.checked[1]!.key).toBe(rig.keys.providers[0]);
    expect(rig.vm.report).toBe(second);
    expect(rig.store.saved).toEqual([]); // not taken yet
    await rig.press("continue"); // the choice is made: the result finishes
    expect(rig.vm.outcome).toBe(WizardOutcome.Connected);
    expect(rig.store.saved).toHaveLength(1);
    expect(rig.store.saved[0]!.endpoint!.model).toBe("m2");
    expect(rig.store.saved[0]!.report).toBe(second);
    expect(rig.checker.checked).toHaveLength(2);
  });

  it("OwnModel goes to OwnFailed when the other model fails its check", async () => {
    const { rig } = await modelStep();
    rig.checker.report.returns(failingReport("https://api.openai.com/v1", "ModelNotFound"));
    rig.vm.selectedModel = "m2";
    await rig.press("continue");
    expect(rig.vm.step).toBe(WizardStep.OwnFailed);
    expect(rig.vm.problem).toBe("ModelNotFound");
    expect(rig.store.saved).toEqual([]);
  });

  it("OwnModel offers Continue only with a model picked and goes back to OwnResult", async () => {
    const { rig } = await modelStep();
    rig.vm.selectedModel = undefined;
    unavailable(rig, "continue");
    rig.vm.selectedModel = "m2";
    expect(rig.vm.can.continue).toBe(true);
    await rig.press("back");
    expect(rig.vm.step).toBe(WizardStep.OwnResult);
  });
});

// =====================================================================================================================
// App steps
// =====================================================================================================================

describe("wizard: the app's steps", () => {
  it("app steps run at their points in order and each sees its context", async () => {
    const log: string[] = [];
    const beforeServer1 = new FakeStep(WizardPoint.BeforeServerCheck, "check-1", log);
    const beforeServer2 = new FakeStep(WizardPoint.BeforeServerCheck, "check-2", log);
    const after = new FakeStep(WizardPoint.AfterConnect, "after", log);
    const beforeChoice = new FakeStep(WizardPoint.BeforeChoice, "choice", log);
    const beforeEndpoint = new FakeStep(WizardPoint.BeforeEndpointCheck, "endpoint", log);
    const rig = make(made({ steps: [beforeServer1, after, beforeChoice, beforeServer2, beforeEndpoint] }));
    await rig.start();
    await rig.press("chooseServer");
    rig.vm.serverAddressText = ADDRESS;
    const wait = rig.sign.waitScript.pending();
    await rig.press("submitServer");
    wait.complete(approve("main-agent"));
    await flush();
    await rig.advance(PAUSE);
    expect(log).toEqual(["choice", "check-1", "check-2", "after"]); // the endpoint step belongs to path B
    expect(href(beforeServer1.contexts[0]!.server)).toBe(ORG);
    expect(href(beforeServer2.contexts[0]!.server)).toBe(ORG);
    const finished = after.contexts[0]!;
    expect(finished.point).toBe(WizardPoint.AfterConnect);
    expect(href(finished.server)).toBe(ORG);
    expect(finished.result).toBe(rig.vm.result);
    expect(finished.endpoint).toBeUndefined();
    expect(beforeEndpoint.contexts).toEqual([]);
  });

  it("a step that says false stops the ones after it at that point", async () => {
    const log: string[] = [];
    const first = new FakeStep(WizardPoint.BeforeServerCheck, "first", log);
    first.script.returns(false);
    const second = new FakeStep(WizardPoint.BeforeServerCheck, "second", log);
    const rig = make(made({ steps: [first, second] }));
    await submitAddress(rig);
    expect(log).toEqual(["first"]);
    expect(rig.vm.step).toBe(WizardStep.ServerAddress);
    expect(rig.vm.appStepRefused).toBe(true);
  });

  it("a step that throws stops the flow like one that says false", async () => {
    const step = new FakeStep(WizardPoint.BeforeServerCheck);
    step.script.throws(new Error("boom"));
    const rig = make(made({ steps: [step] }));
    await submitAddress(rig);
    expect(rig.vm.step).toBe(WizardStep.ServerAddress);
    expect(rig.vm.appStepRefused).toBe(true);
    expect(rig.sign.checked).toEqual([]);
  });

  it("AppStepRefused clears when the person tries again", async () => {
    const step = new FakeStep(WizardPoint.BeforeServerCheck);
    step.script.returns(false).returns(true);
    const rig = make(made({ steps: [step] }));
    rig.sign.checkScript.pending();
    await submitAddress(rig);
    expect(rig.vm.appStepRefused).toBe(true);
    await rig.press("submitServer");
    expect(rig.vm.step).toBe(WizardStep.Checking);
    expect(rig.vm.appStepRefused).toBe(false);
  });

  it("AfterConnect false saves nothing and goes back to the choice on a first run", async () => {
    const step = new FakeStep(WizardPoint.AfterConnect);
    step.script.returns(false);
    const rig = make(made({ steps: [step] }));
    const wait = rig.sign.waitScript.pending();
    await submitAddress(rig);
    wait.complete(approve("main-agent"));
    await flush();
    await rig.advance(PAUSE);
    expect(rig.vm.step).toBe(WizardStep.Choose);
    expect(rig.store.saved).toEqual([]);
    expect(rig.vm.result).toBeUndefined();
    expect(rig.vm.outcome).toBe(WizardOutcome.None);
    expect(rig.completed).toEqual([]);
  });

  it("AfterConnect false on path B goes back to Settings when it began there", async () => {
    const step = new FakeStep(WizardPoint.AfterConnect);
    step.script.throws(new Error("the app refused the connection"));
    const rig = make(made({ entry: WizardEntry.Settings, current: SERVER_CONNECTION, steps: [step] }));
    await rig.start();
    await rig.press("changeEndpoint");
    rig.vm.accepted = true;
    await rig.press("accept");
    await pick(rig, EndpointPreset.ollama);
    await useEndpoint(rig);
    await rig.press("continue");
    expect(rig.vm.step).toBe(WizardStep.Settings);
    expect(rig.store.saved).toEqual([]);
    expect(rig.vm.result).toBeUndefined();
  });
});

// =====================================================================================================================
// Stale answers
// =====================================================================================================================

describe("wizard: stale answers", () => {
  it("a health check answer after Cancel changes nothing", async () => {
    const rig = make();
    const check = rig.sign.checkScript.pending(false);
    await submitAddress(rig);
    await rig.press("cancel");
    check.complete();
    await flush();
    expect(rig.vm.step).toBe(WizardStep.ServerAddress);
    expect(rig.store.servers).toEqual([]);
    expect(rig.sign.started).toEqual([]);
  });

  it("a health check failure after Cancel changes nothing", async () => {
    const rig = make();
    const check = rig.sign.checkScript.pending(false);
    await submitAddress(rig);
    await rig.press("cancel");
    check.fail(new FadenstackUnreachableError("no answer"));
    await flush();
    expect(rig.vm.step).toBe(WizardStep.ServerAddress);
  });

  it("a ticket after Cancel shows no code", async () => {
    const rig = make(made({ entry: WizardEntry.ServerKnown, server: new URL(ORG) }));
    const start = rig.sign.startScript.pending(false);
    await rig.start();
    await rig.press("cancel");
    start.complete(makeTicket(rig.clock.now() + 600_000));
    await flush();
    expect(rig.vm.step).toBe(WizardStep.ServerAddress);
    expect(rig.vm.userCode).toBeUndefined();
    expect(rig.sign.waited).toEqual([]);
    expect(rig.clock.activeTimers).toBe(0);
  });

  it("an approval after Cancel signs nobody in", async () => {
    let wait!: PendingAnswer<PairingApproval>;
    const rig = await pairCode(undefined, (r) => { wait = r.sign.waitScript.pending(false); });
    await rig.press("cancel");
    expect(rig.vm.step).toBe(WizardStep.ServerAddress);
    expect(rig.sign.waited[0]!.signal.aborted).toBe(true);
    wait.complete(approve("main-agent"));
    await flush();
    expect(rig.vm.step).toBe(WizardStep.ServerAddress);
    expect(rig.vm.person).toBeUndefined();
    expect(rig.vm.agents).toEqual([]);
    expect(rig.vm.result).toBeUndefined();
    expect(rig.store.saved).toEqual([]);
    expect(rig.clock.activeTimers).toBe(0);
  });

  it("a collected agent after Cancel changes nothing", async () => {
    let redeem!: PendingAnswer<AgentSignIn>;
    const { rig, wait } = await suitePairCode([], (r) => { redeem = r.sign.redeemScript.pending(false); });
    wait.complete(approve("word"));
    await flush();
    expect(rig.vm.step).toBe(WizardStep.Redeeming);
    await rig.press("cancel");
    redeem.complete(approved("excel"));
    await flush();
    expect(rig.vm.step).toBe(WizardStep.ServerAddress);
    expect(rig.store.saved).toEqual([]);
    expect(rig.vm.result).toBeUndefined();
  });

  it("an old check answer does not overwrite a newer one", async () => {
    const rig = make();
    const old = rig.sign.checkScript.pending(false);
    await submitAddress(rig);
    await rig.press("cancel");
    rig.sign.checkScript.throws(new ServerCertificateError("not trusted"));
    await rig.press("submitServer");
    expect(rig.vm.step).toBe(WizardStep.CertificateNotTrusted);
    old.complete(); // the first request answers last, and fine
    await flush();
    expect(rig.vm.step).toBe(WizardStep.CertificateNotTrusted);
    expect(rig.store.servers).toEqual([]);
  });

  it("dispose makes every answer stale", async () => {
    const rig = make();
    const check = rig.sign.checkScript.pending(false);
    await submitAddress(rig);
    rig.dispose();
    check.complete();
    await flush();
    expect(rig.vm.step).toBe(WizardStep.Checking);
    expect(rig.store.servers).toEqual([]);
  });
});

// =====================================================================================================================
// Life cycle
// =====================================================================================================================

describe("wizard: life cycle", () => {
  it("start twice throws", async () => {
    const rig = make();
    await rig.start();
    expect(() => rig.vm.start()).toThrow(/once/);
  });

  it("dispose stops the countdown, the wait and the rate limit timer", async () => {
    const rig = await pairCode();
    expect(rig.clock.activeTimers).toBe(1);
    rig.dispose();
    expect(rig.clock.activeTimers).toBe(0);
    expect(rig.sign.waited[0]!.signal.aborted).toBe(true);
    await rig.advance(3_600_000);
    expect(rig.vm.step).toBe(WizardStep.PairCode);

    const limited = make(made({ entry: WizardEntry.ServerKnown, server: new URL(ORG) }));
    limited.sign.startScript.throws(new FadenstackRateLimitedError(429, "slow", undefined, 30_000));
    await limited.start();
    expect(limited.clock.activeTimers).toBe(1);
    limited.dispose();
    expect(limited.clock.activeTimers).toBe(0);
  });

  it("dispose stops the signed-in pause", async () => {
    let wait!: PendingAnswer<PairingApproval>;
    const rig = await pairCode(undefined, (r) => { wait = r.sign.waitScript.pending(); });
    wait.complete(approve("main-agent"));
    await flush();
    expect(rig.clock.activeTimers).toBe(1);
    rig.dispose();
    await rig.advance(PAUSE);
    expect(rig.vm.step).toBe(WizardStep.SignedIn);
    expect(rig.store.saved).toEqual([]);
  });

  it("finishing stops the timers", async () => {
    const rig = await pairCode();
    rig.vm.close();
    expect(rig.vm.step).toBe(WizardStep.Finished);
    expect(rig.clock.activeTimers).toBe(0);
    expect(rig.sign.waited[0]!.signal.aborted).toBe(true);
    expect(rig.completed).toEqual([WizardOutcome.Closed]);
  });

  it("the constructor throws when the server path is offered without a sign-in", () => {
    expect(() => new ConnectionWizardViewModel(DEFAULT_OPTIONS, new FakeConnectionStore(), { keys: new FakeKeyStore() })).toThrow(/server/);
  });

  it("the constructor throws when own AI is offered without a key store", () => {
    expect(() => new ConnectionWizardViewModel(DEFAULT_OPTIONS, new FakeConnectionStore(), { server: new FakeServerSignIn(() => Date.now()) })).toThrow(/key store/);
  });

  it("the constructor does not need what a path that is not offered would use", () => {
    const serverOnly = new ConnectionWizardViewModel({ ...DEFAULT_OPTIONS, offersOwnAi: false }, new FakeConnectionStore(), { server: new FakeServerSignIn(() => Date.now()) });
    const ownOnly = new ConnectionWizardViewModel({ ...DEFAULT_OPTIONS, offersServer: false }, new FakeConnectionStore(), { keys: new FakeKeyStore() });
    expect(serverOnly.step).toBe(WizardStep.Choose);
    expect(ownOnly.step).toBe(WizardStep.Choose);
    expect(() => new ConnectionWizardViewModel(undefined as never, new FakeConnectionStore())).toThrow(TypeError);
    expect(() => new ConnectionWizardViewModel(DEFAULT_OPTIONS, undefined as never)).toThrow(TypeError);
  });

  it("a skin is told about every change and can read a version", async () => {
    const rig = make();
    let told = 0;
    const stop = rig.vm.subscribe(() => told++);
    const before = rig.vm.version;
    await rig.start();
    await rig.press("chooseServer");
    expect(told).toBeGreaterThan(0);
    expect(rig.vm.version).toBeGreaterThan(before);
    stop();
    const seen = told;
    rig.vm.serverAddressText = "x.example.test";
    expect(told).toBe(seen);
  });
});

// =====================================================================================================================
// No secret in the view model (F15 "Rules", ASVS 5.0 V13)
// =====================================================================================================================

/** Walks every public property (own and from the prototypes) and nested record, looking for a secret in what it says. */
function assertNoSecret(root: unknown, where: string, ...secrets: string[]): void {
  const seen = new Set<object>();
  const check = (text: string, path: string): void => {
    for (const secret of secrets) expect(text.includes(secret), `${where}: ${path} has a secret in its text`).toBe(false);
  };
  const walk = (value: unknown, path: string, depth: number): void => {
    if (value === null || value === undefined || depth > 6 || typeof value === "function") return;
    if (typeof value !== "object") {
      check(String(value), path);
      return;
    }
    check(String(value), path);
    if (value instanceof URL || value instanceof Date || value instanceof AbortSignal || seen.has(value)) return;
    seen.add(value);
    try {
      check(JSON.stringify(value) ?? "", `${path} (as JSON)`);
    } catch {
      // not serialisable: its properties are walked below
    }
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, `${path}[]`, depth + 1));
      return;
    }
    const names = new Set<string>();
    for (let o: object | null = value; o && o !== Object.prototype; o = Object.getPrototypeOf(o) as object | null) {
      Object.getOwnPropertyNames(o).forEach((n) => names.add(n));
    }
    for (const name of names) {
      if (name === "constructor") continue;
      let property: unknown;
      try {
        property = (value as Record<string, unknown>)[name];
      } catch {
        continue;
      }
      walk(property, `${path}.${name}`, depth + 1);
    }
  };
  walk(root, "wizard", 0);
}

describe("wizard: no secret in the view model", () => {
  it("after a key is submitted no public property of the view model has it", async () => {
    const key = "sk-live-SECRET-9f3a7c1d";
    const rig = await ownPick();
    await pick(rig, EndpointPreset.openAi);
    await useEndpoint(rig);
    assertNoSecret(rig.vm, "at the key step", key);
    await rig.press("submitKey", key);
    expect(rig.vm.step).toBe(WizardStep.OwnResult);
    expect(rig.vm.keySet).toBe(true);
    assertNoSecret(rig.vm, "at the result", key);
    await rig.press("continue");
    expect(rig.vm.outcome).toBe(WizardOutcome.Connected);
    assertNoSecret(rig.vm, "when finished", key);
    assertNoSecret(rig.vm.result, "the result", key);
    assertNoSecret(rig.store.saved, "the saved results", key);
    assertNoSecret(rig.store.acceptances, "the acceptance records", key);
    assertNoSecret(rig.store.servers, "the saved servers", key);
  });

  it("after a wrong key and a failed check the key is still in no property", async () => {
    const key = "sk-wrong-SECRET-1b2c3d";
    const rig = await ownPick(undefined, (r) => r.checker.report.returns(failingReport("https://api.openai.com/v1", "KeyRejected")));
    await pick(rig, EndpointPreset.openAi);
    await useEndpoint(rig);
    await rig.press("submitKey", key);
    expect(rig.vm.step).toBe(WizardStep.OwnFailed);
    assertNoSecret(rig.vm, "after the rejected key", key);
  });

  it("after a password sign-in no public property of the view model has the password", async () => {
    const password = "hunter2-SECRET-passw0rd";
    const rig = await passwordStep((r) => r.sign.passwordScript.returns(approve("main-agent")));
    rig.vm.email = "ana@example.test";
    await rig.press("signInWithPassword", password);
    expect(rig.vm.step).toBe(WizardStep.SignedIn);
    assertNoSecret(rig.vm, "at SignedIn", password);
    await rig.advance(PAUSE);
    expect(rig.vm.outcome).toBe(WizardOutcome.Connected);
    assertNoSecret(rig.vm, "when finished", password);
    assertNoSecret(rig.vm.result, "the result", password);
    assertNoSecret(rig.store.saved, "the saved results", password);
  });

  it("after a failed password sign-in the password is in no property", async () => {
    const password = "hunter2-SECRET-passw0rd";
    const rig = await passwordStep((r) => r.sign.passwordScript.throws(new FadenstackBadCredentialsError()));
    rig.vm.email = "ana@example.test";
    await rig.press("signInWithPassword", password);
    expect(rig.vm.step).toBe(WizardStep.PasswordError);
    assertNoSecret(rig.vm, "after the wrong password", password);
  });

  it("the pairing code is in no property at the code, and the ticket's text has none", async () => {
    const rig = await pairCode(made({ pairingKeeper: new MemoryKeeper() }));
    assertNoSecret(rig.vm, "at the code", PAIRING_SECRET);
    expect(String(rig.sign.waited[0]!.ticket)).not.toContain("BDWP-HTQX");
  });

  it("the secret walk does find a secret that is there", () => {
    const result: ConnectionResult = {
      mode: ConnectionMode.Endpoint, endpoint: { baseUrl: new URL("https://x.test/v1"), model: "sk-leaked" },
    };
    expect(() => assertNoSecret(result, "a leak", "sk-leaked")).toThrow();
  });
});

// =====================================================================================================================
// Store failures, a cancelled collection, an address that cannot be placed (review of the first pass)
// =====================================================================================================================

describe("wizard: store failures and edge cases", () => {
  it("saving the server fails back at the address with StoreFailed and no pairing starts", async () => {
    const rig = make();
    await rig.start();
    await rig.press("chooseServer");
    rig.vm.serverAddressText = ADDRESS;
    rig.store.failure = new Error("The settings file is read-only.");
    await rig.press("submitServer");
    expect(rig.vm.step).toBe(WizardStep.ServerAddress);
    expect(rig.vm.storeFailed).toBe(true);
    expect(rig.sign.started).toEqual([]);
    rig.store.failure = undefined;
    await rig.press("submitServer");
    expect(rig.vm.storeFailed).toBe(false);
    expect(rig.vm.step).toBe(WizardStep.PairCode);
  });

  it("saving the acceptance fails and the person stays at the acceptance", async () => {
    const rig = make();
    await rig.start();
    await rig.press("chooseOwnAi");
    rig.vm.accepted = true;
    rig.vm.searchConsent = true;
    rig.store.failure = new Error("disk full");
    await rig.press("accept");
    expect(rig.vm.step).toBe(WizardStep.OwnAccept);
    expect(rig.vm.storeFailed).toBe(true);
    expect(rig.store.acceptances).toEqual([]);
    expect(rig.checker.find.calls).toBe(0);
  });

  it("saving the connection fails back at the start and nothing completes", async () => {
    let wait!: PendingAnswer<PairingApproval>;
    const rig = await pairCode(undefined, (r) => { wait = r.sign.waitScript.pending(); });
    rig.store.failure = new Error("disk full");
    wait.complete(approve("main-agent"));
    await flush();
    await rig.advance(PAUSE);
    expect(rig.vm.step).toBe(WizardStep.Choose);
    expect(rig.vm.storeFailed).toBe(true);
    expect(rig.vm.result).toBeUndefined();
    expect(rig.completed).toEqual([]);
  });

  it("signing out fails: it stays at the sign-out and works on the next try", async () => {
    const rig = settingsRig();
    await rig.start();
    await rig.press("signOut");
    rig.store.failure = new Error("locked");
    await rig.press("confirmSignOut");
    expect(rig.vm.step).toBe(WizardStep.SignOut);
    expect(rig.vm.storeFailed).toBe(true);
    expect(rig.completed).toEqual([]);
    rig.store.failure = undefined;
    await rig.press("confirmSignOut");
    expect(rig.vm.outcome).toBe(WizardOutcome.SignedOut);
    expect(rig.vm.storeFailed).toBe(false);
  });

  it("a key store that fails leaves the key step with StoreFailed and nothing stuck busy", async () => {
    const rig = await ownPick();
    await pick(rig, EndpointPreset.openAi);
    await useEndpoint(rig);
    rig.keys.save = () => Promise.reject(new Error("no storage"));
    await rig.press("submitKey", "sk-x");
    expect(rig.vm.step).toBe(WizardStep.OwnKey);
    expect(rig.vm.storeFailed).toBe(true);
    expect(rig.vm.isBusy).toBe(false);
    expect(rig.vm.keySet).toBe(false);
  });

  it("Cancel while collecting the agents sends no more requests", async () => {
    let redeem!: PendingAnswer<AgentSignIn>;
    const { rig, wait } = await suitePairCode([], (r) => { redeem = r.sign.redeemScript.pending(false); });
    wait.complete(approve("word"));
    await flush();
    expect(rig.vm.step).toBe(WizardStep.Redeeming);
    await rig.press("cancel");
    redeem.complete(approved("excel"));
    await flush();
    expect(rig.sign.redeemed).toEqual(["excel"]);
    expect(rig.vm.step).toBe(WizardStep.ServerAddress);
  });

  it("an address whose place cannot be told is refused for plain http", async () => {
    const rig = await ownPick();
    rig.checker.placeFailure = new Error("resolver broke");
    type(rig, "http://nas.example.lan:11434/v1");
    await useEndpoint(rig);
    expect(rig.vm.step).toBe(WizardStep.OwnPick);
    expect(rig.vm.addressError).toBe(AddressProblem.HttpsRequired);
    expect(rig.checker.checked).toEqual([]);
  });

  it("a place that is told with a promise (as .NET does) works the same", async () => {
    const rig = await ownPick(undefined, (r) => { r.checker.asyncPlace = true; lanPlace(r); });
    type(rig, LAN);
    await useEndpoint(rig);
    expect(rig.vm.step).toBe(WizardStep.OwnPlainHttp);
    rig.checker.placeFailure = new Error("resolver broke");
    await rig.press("back");
    type(rig, "http://nas.example.lan:11434/v1");
    await useEndpoint(rig);
    expect(rig.vm.addressError).toBe(AddressProblem.HttpsRequired);
  });
});

// =====================================================================================================================
// TypeScript's own (1): the app's step before a check runs inside the user gesture
// =====================================================================================================================

describe("wizard: the gesture rule (Chrome's chrome.permissions.request)", () => {
  /** A rig at the pick whose BeforeEndpointCheck step sets a flag the moment it runs. */
  async function gestureRig(configure?: Configure, before?: (rig: WizardRig) => void): Promise<{ rig: WizardRig; step: FakeStep; ran: () => boolean }> {
    const step = new FakeStep(WizardPoint.BeforeEndpointCheck);
    let ran = false;
    step.onRun = () => { ran = true; };
    const rig = await ownPick((o) => ({ ...(configure ? configure(o) : o), steps: [step] }), before);
    return { rig, step, ran: () => ran };
  }

  it("calls the step synchronously inside useEndpoint() for an https address, before any await", async () => {
    const { rig, ran } = await gestureRig();
    type(rig, "https://api.example.test/v1");
    const done = rig.vm.useEndpoint(); // not awaited: what a click handler does
    expect(ran()).toBe(true);
    await done;
    expect(rig.vm.step).toBe(WizardStep.OwnResult);
  });

  it("calls the step synchronously for a preset that needs no key and for http to this computer (placeOf answers at once)", async () => {
    const { rig, ran } = await gestureRig();
    await pick(rig, EndpointPreset.ollama);
    const done = rig.vm.useEndpoint();
    expect(ran()).toBe(true);
    expect(rig.checker.placeAsked).toEqual([OLLAMA]); // placeOf was asked, and answered without a promise
    await done;
  });

  it("the default checker's placeOf answers at once, without a promise", () => {
    const checker = createEndpointChecker();
    expect(checker.placeOf(new URL("http://localhost:11434/v1"), new AbortController().signal)).toBe(EndpointPlace.ThisComputer);
    expect(checker.placeOf(new URL("http://192.168.1.20/v1"), new AbortController().signal)).toBe(EndpointPlace.LocalNetwork);
    expect(checker.placeOf(new URL("http://8.8.8.8/v1"), new AbortController().signal)).toBe(EndpointPlace.Internet);
  });

  it("calls the step synchronously in confirmPlainHttp(), in retry() and in a continue() that checks another model", async () => {
    const lan = await gestureRig(undefined, lanPlace);
    type(lan.rig, LAN);
    await lan.rig.press("useEndpoint");
    expect(lan.rig.vm.step).toBe(WizardStep.OwnPlainHttp);
    const confirmed = lan.rig.vm.confirmPlainHttp();
    expect(lan.ran()).toBe(true);
    await confirmed;

    const failing = await gestureRig(undefined, (r) => r.checker.report.returns(failingReport(OLLAMA, "Unreachable")));
    await pick(failing.rig, EndpointPreset.ollama);
    await failing.rig.press("useEndpoint");
    expect(failing.rig.vm.step).toBe(WizardStep.OwnFailed);
    failing.step.contexts.length = 0;
    let again = false;
    failing.step.onRun = () => { again = true; };
    const retried = failing.rig.vm.retry();
    expect(again).toBe(true);
    await retried;

    const models = await gestureRig(undefined, (r) => r.checker.report.returns(usableReport(OLLAMA, "m1", "m1", "m2")));
    await pick(models.rig, EndpointPreset.ollama);
    await models.rig.press("useEndpoint");
    await models.rig.press("continue");
    expect(models.rig.vm.step).toBe(WizardStep.OwnModel);
    models.rig.vm.selectedModel = "m2";
    let other = false;
    models.step.onRun = () => { other = true; };
    const chosen = models.rig.vm.continue();
    expect(other).toBe(true);
    await chosen;
  });

  it("with a key, saving the key comes first (one short await) and the step still runs before the check", async () => {
    const { rig, step, ran } = await gestureRig();
    await pick(rig, EndpointPreset.openAi);
    await rig.press("useEndpoint");
    expect(rig.vm.step).toBe(WizardStep.OwnKey);
    const done = rig.vm.submitKey("sk-test-1234");
    // the key store is awaited first, so the step runs a few microtasks later: still before the check, which waits for it
    expect(rig.checker.checked).toEqual([]);
    await done;
    expect(ran()).toBe(true);
    expect(step.contexts[0]!.endpoint!.key).toBe(rig.keys.providers[0]);
  });

  it("a placeOf that returns a promise puts one await before the step (the contract allows it)", async () => {
    const { rig, ran } = await gestureRig(undefined, (r) => { r.checker.asyncPlace = true; });
    await pick(rig, EndpointPreset.ollama);
    const done = rig.vm.useEndpoint();
    expect(ran()).toBe(false);
    await done;
    expect(ran()).toBe(true);
  });
});

// =====================================================================================================================
// TypeScript's own (2): a pairing that survives a closed panel (I15 §2)
// =====================================================================================================================

describe("wizard: the pairing keeper", () => {
  const withKeeper = (keeper: MemoryKeeper, extra: Partial<WizardOptions> = {}): Configure => made({ pairingKeeper: keeper, ...extra });
  const known: Partial<WizardOptions> = { entry: WizardEntry.ServerKnown, server: new URL(ORG) };

  /** A panel that was open at the code and is closed: the kept pairing stays in the keeper (a new view model is the reopened panel). */
  async function closedAtCode(keeper: MemoryKeeper, extra: Partial<WizardOptions> = {}): Promise<WizardRig> {
    const first = await pairCode(withKeeper(keeper, extra));
    await flush();
    await flush(); // a slow keeper
    expect(keeper.saved).toBeDefined();
    first.dispose(); // the panel closes: the wait stops, the pairing is not forgotten
    return first;
  }

  it("keeps the pairing when the code shows, with the server, the expiry and the pairing code", async () => {
    const keeper = new MemoryKeeper();
    const rig = await pairCode(withKeeper(keeper));
    expect(keeper.calls).toEqual(["restore", "keep"]);
    expect(keeper.saved!.server).toBe(ORG);
    expect(keeper.saved!.expiresAt).toBe(rig.sign.waited[0]!.ticket.expiresAt);
    expect(keeper.saved!.pairing.userCode).toBe("BDWP-HTQX");
    expect(keeper.saved!.pairing.pairingCode).toBe(PAIRING_SECRET);
  });

  it("closing the panel (dispose) keeps the pairing", async () => {
    const keeper = new MemoryKeeper();
    await closedAtCode(keeper);
    await flush();
    expect(keeper.saved).toBeDefined();
    expect(keeper.calls).toEqual(["restore", "keep"]);
  });

  it("resumes at the code after a panel reopen: a new view model, the same code, no new start, the wait goes on", async () => {
    const keeper = new MemoryKeeper();
    const first = await closedAtCode(keeper);
    const rig = make(withKeeper(keeper, { entry: WizardEntry.ServerKnown, server: new URL(ORG) }));
    rig.clock.time = first.clock.time + 60_000; // a minute later, the code still has nine
    await rig.start();
    expect(rig.vm.step).toBe(WizardStep.PairCode);
    expect(rig.vm.userCode).toBe("BDWP-HTQX");
    expect(rig.sign.started, "no new pairing is asked for").toEqual([]);
    expect(rig.sign.resumed).toEqual([{ server: ORG, userCode: "BDWP-HTQX" }]);
    expect(rig.sign.waited).toHaveLength(1);
    expect(rig.vm.timeLeftMs).toBe(540_000);
    expect(keeper.calls).toEqual(["restore", "keep", "restore"]); // not kept again: it is kept already
  });

  it("a resumed pairing that is approved signs in and forgets it", async () => {
    const keeper = new MemoryKeeper();
    await closedAtCode(keeper);
    const rig = make(withKeeper(keeper, known));
    const wait = rig.sign.waitScript.pending();
    await rig.start();
    expect(rig.vm.step).toBe(WizardStep.PairCode);
    wait.complete(approve("main-agent"));
    await flush();
    expect(rig.vm.step).toBe(WizardStep.SignedIn);
    expect(keeper.saved).toBeUndefined();
    await rig.advance(PAUSE);
    expect(rig.vm.outcome).toBe(WizardOutcome.Connected);
  });

  it("the first run resumes at the code too, for the server the person typed", async () => {
    const keeper = new MemoryKeeper();
    await closedAtCode(keeper);
    const rig = make(withKeeper(keeper));
    await rig.start();
    expect(rig.vm.step).toBe(WizardStep.PairCode);
    expect(href(rig.vm.serverUrl)).toBe(ORG);
    expect(rig.vm.serverAddressText).toBe(ORG);
    expect(rig.sign.started).toEqual([]);
    expect(rig.sign.checked).toEqual([]);
  });

  it("the first run with the app's step before the choice runs it, then resumes", async () => {
    const keeper = new MemoryKeeper();
    await closedAtCode(keeper);
    const step = new FakeStep(WizardPoint.BeforeChoice);
    const rig = make(withKeeper(keeper, { steps: [step] }));
    await rig.start();
    expect(step.contexts).toHaveLength(1);
    expect(rig.vm.step).toBe(WizardStep.PairCode);
  });

  it("the first run shows the choice when nothing is kept", async () => {
    const keeper = new MemoryKeeper();
    const rig = make(withKeeper(keeper));
    await rig.start();
    expect(rig.vm.step).toBe(WizardStep.Choose);
    expect(keeper.calls).toEqual(["restore"]);
  });

  it("a re-sign-in resumes with the banner", async () => {
    const keeper = new MemoryKeeper();
    await closedAtCode(keeper);
    const rig = make(withKeeper(keeper, { entry: WizardEntry.ReSignIn, server: new URL(ORG) }));
    await rig.start();
    expect(rig.vm.step).toBe(WizardStep.PairCode);
    expect(rig.vm.signInEnded).toBe(true);
  });

  it("works with a keeper that answers after a macrotask, as the extension storage does", async () => {
    const keeper = new MemoryKeeper();
    keeper.slow = true;
    await closedAtCode(keeper);
    const rig = make(withKeeper(keeper, known));
    await rig.start();
    await flush();
    await flush();
    expect(rig.vm.step).toBe(WizardStep.PairCode);
    expect(rig.sign.started).toEqual([]);
  });

  it("forgets the pairing when it is approved", async () => {
    const keeper = new MemoryKeeper();
    let wait!: PendingAnswer<PairingApproval>;
    const rig = await pairCode(withKeeper(keeper), (r) => { wait = r.sign.waitScript.pending(); });
    wait.complete(approve("main-agent"));
    await flush();
    expect(keeper.saved).toBeUndefined();
    expect(keeper.calls).toEqual(["restore", "keep", "forget"]);
    expect(rig.vm.step).toBe(WizardStep.SignedIn);
  });

  it.each([
    ["denied", new FadenstackPairingDeniedError("denied")],
    ["expired at the server", new FadenstackPairingExpiredError("expired")],
    ["failed", new FadenstackApiError(500, "oops")],
  ] as const)("forgets the pairing when the wait ends %s", async (_, error) => {
    const keeper = new MemoryKeeper();
    let wait!: PendingAnswer<PairingApproval>;
    await pairCode(withKeeper(keeper), (r) => { wait = r.sign.waitScript.pending(); });
    wait.fail(error);
    await flush();
    expect(keeper.saved).toBeUndefined();
    expect(keeper.calls).toEqual(["restore", "keep", "forget"]);
  });

  it("forgets the pairing when the countdown runs out", async () => {
    const keeper = new MemoryKeeper();
    const rig = make(withKeeper(keeper));
    rig.sign.startScript.returns(makeTicket(rig.clock.now() + 3000));
    await submitAddress(rig);
    expect(keeper.saved).toBeDefined();
    await rig.advance(3000);
    expect(rig.vm.step).toBe(WizardStep.Expired);
    expect(keeper.saved).toBeUndefined();
  });

  it.each(["cancel", "changeServer", "close"] as const)("forgets the pairing on %s", async (command) => {
    const keeper = new MemoryKeeper();
    const rig = await pairCode(withKeeper(keeper));
    expect(keeper.saved).toBeDefined();
    await rig.press(command);
    expect(keeper.saved).toBeUndefined();
  });

  it("forgets the pairing when the person chooses a password", async () => {
    const keeper = new MemoryKeeper();
    const rig = await pairCode(withKeeper(keeper, { passwordFallback: true }));
    await rig.press("usePassword");
    expect(keeper.saved).toBeUndefined();
  });

  it("a kept pairing that has expired is forgotten and a new one starts", async () => {
    const keeper = new MemoryKeeper();
    const first = await closedAtCode(keeper);
    const rig = make(withKeeper(keeper, known));
    rig.clock.time = first.clock.time + 601_000; // the code is over
    rig.sign.startScript.returns(makeTicket(rig.clock.now() + 600_000, "NEW1-CODE"));
    await rig.start();
    expect(rig.sign.resumed).toEqual([]);
    expect(rig.sign.started).toEqual([ORG]);
    expect(rig.vm.userCode).toBe("NEW1-CODE");
    expect(keeper.saved!.pairing.userCode).toBe("NEW1-CODE"); // the old one was forgotten, the new one is kept
    expect(keeper.calls).toEqual(["restore", "keep", "restore", "forget", "keep"]);
  });

  it("a kept pairing for another server is forgotten and a new one starts", async () => {
    const keeper = new MemoryKeeper();
    await closedAtCode(keeper);
    const rig = make(withKeeper(keeper, { entry: WizardEntry.ServerKnown, server: new URL("https://other.example.test/") }));
    await rig.start();
    expect(rig.sign.resumed).toEqual([]);
    expect(rig.sign.started).toEqual(["https://other.example.test/"]);
  });

  it("a kept pairing is not used against the machine policy's server", async () => {
    const keeper = new MemoryKeeper();
    await closedAtCode(keeper);
    const policy = policyOf({ server: new URL(CORP), standalone: PolicyAccess.Forbidden });
    const rig = make(withKeeper(keeper, { policy }));
    await rig.start();
    expect(rig.sign.resumed).toEqual([]);
    expect(rig.sign.started).toEqual([CORP]);
  });

  it("an unreadable or insecure kept pairing is forgotten and a new one starts", async () => {
    const keeper = new MemoryKeeper();
    keeper.saved = { server: "not a server", expiresAt: Date.now() + 1e9, pairing: {} as never };
    const rig = make(withKeeper(keeper, known));
    await rig.start();
    expect(rig.sign.resumed).toEqual([]);
    expect(rig.sign.started).toEqual([ORG]);
    const http = new MemoryKeeper();
    http.saved = { server: "http://ai.example.test/", expiresAt: Number.MAX_SAFE_INTEGER, pairing: {} as never };
    const other = make(withKeeper(http, known));
    await other.start();
    expect(other.sign.resumed).toEqual([]);
  });

  it("a pairing the sign-in cannot resume is forgotten and a new one starts", async () => {
    const keeper = new MemoryKeeper();
    await closedAtCode(keeper);
    const rig = make(withKeeper(keeper, known));
    rig.sign.resumeFailure = new FadenstackPairingPageElsewhereError("elsewhere");
    await rig.start();
    expect(rig.sign.resumed).toHaveLength(1);
    expect(rig.sign.started).toEqual([ORG]);
    expect(keeper.saved!.pairing.userCode).toBe("BDWP-HTQX"); // the fresh start's code, kept again
    expect(rig.vm.step).toBe(WizardStep.PairCode);
  });

  it("a keeper that fails never fails the flow", async () => {
    const keeper = new MemoryKeeper();
    keeper.failure = new Error("storage is gone");
    const rig = await pairCode(withKeeper(keeper));
    expect(rig.vm.step).toBe(WizardStep.PairCode);
    const again = make(withKeeper(keeper, known));
    await again.start();
    expect(again.vm.step).toBe(WizardStep.PairCode);
    expect(again.sign.started).toEqual([ORG]); // nothing could be restored: a new start
  });

  it("a sign-in that cannot export or resume keeps nothing and asks for a new code", async () => {
    const keeper = new MemoryKeeper();
    const rig = make(withKeeper(keeper));
    (rig.sign as { export?: unknown }).export = undefined;
    (rig.sign as { resume?: unknown }).resume = undefined;
    await submitAddress(rig);
    expect(rig.vm.step).toBe(WizardStep.PairCode);
    expect(keeper.calls).toEqual([]);
  });

  it("without a keeper nothing changes", async () => {
    const rig = make(made(known));
    rig.sign.startScript.pending();
    await rig.start();
    expect(rig.vm.step).toBe(WizardStep.PairStarting);
    expect(rig.sign.started).toEqual([ORG]);
  });

  it("the Settings entry does not resume a kept pairing", async () => {
    const keeper = new MemoryKeeper();
    await closedAtCode(keeper);
    const rig = make(withKeeper(keeper, { entry: WizardEntry.Settings, current: SERVER_CONNECTION }));
    await rig.start();
    expect(rig.vm.step).toBe(WizardStep.Settings);
    expect(keeper.calls).toEqual(["restore", "keep"]);
  });
});

// =====================================================================================================================
// The texts (I15 step 3): the computed ones follow the state, in the rig's language (German). .NET: "The texts (I15 step 3)".
// =====================================================================================================================

describe("wizard: the texts", () => {
  it("the waiting line counts down in minutes and seconds", async () => {
    const rig = await pairCode();
    expect(rig.vm.waitingText).toBe("Warten auf Ihre Bestätigung… Der Code läuft in 10:00 ab.");
    await rig.advance(19_000);
    expect(rig.vm.waitingText).toBe("Warten auf Ihre Bestätigung… Der Code läuft in 9:41 ab.");
  });

  it("an address error reads as the path it belongs to", async () => {
    const server = make();
    await server.start();
    await server.press("chooseServer");
    server.vm.serverAddressText = "http://ai.example.test";
    await server.press("submitServer");

    const own = await ownPick();
    type(own, "http://8.8.8.8/v1");
    await useEndpoint(own);

    expect(server.vm.addressErrorText).toBe(server.vm.strings.wizardServerHttpsRequired);
    expect(own.vm.addressErrorText).toBe(own.vm.strings.wizardEndpointHttpsRequired);
    expect(server.vm.addressErrorText).not.toBe(own.vm.addressErrorText);
  });

  it("the result says in plain words what limits the connection and whether it watermarks text", async () => {
    const report = makeReport(OLLAMA, {
      toolCalls: false, problems: ["NoToolCalls", "OllamaDefaultContext"], watermark: { status: "Never", source: null, checked: null, requested: false, confirmed: null },
    });
    const rig = await ownPick(undefined, (r) => r.checker.report.returns(report));
    type(rig, OLLAMA);
    await useEndpoint(rig);

    expect(rig.vm.step).toBe(WizardStep.OwnResult);
    expect(rig.vm.resultLines).toEqual([
      "Die Verbindung funktioniert.",
      "Dieses Modell kann nur chatten: Es kann keine Werkzeuge nutzen.",
      "Ollama betreibt dieses Modell mit seinem kurzen Standardkontext, der lange Eingaben abschneidet. Erhöhen Sie OLLAMA_CONTEXT_LENGTH.",
      "Diese Verbindung kennzeichnet Texte nicht mit einem Wasserzeichen.",
    ]);
  });

  it("a failed check names its problem and the signed-in line names the person", async () => {
    const own = await ownPick(undefined, (r) => r.checker.report.returns(failingReport("https://api.example.test/v1", "KeyRejected")));
    type(own, "https://api.example.test/v1");
    await useEndpoint(own);
    expect(own.vm.problemText).toBe("Der Server hat den Schlüssel abgelehnt.");

    let wait!: PendingAnswer<PairingApproval>;
    const server = await pairCode(undefined, (r) => { wait = r.sign.waitScript.pending(); });
    wait.complete(approve("main-agent"));
    await flush();
    expect(server.vm.signedInText).toBe("Angemeldet als Ana.");
  });

  it("without texts given, English is the default", () => {
    const plain = new ConnectionWizardViewModel(DEFAULT_OPTIONS, new FakeConnectionStore(), { server: new FakeServerSignIn(() => Date.now()), keys: new FakeKeyStore() });
    expect(plain.strings.language).toBe("en");
    expect(plain.signedInText).toBe("Signed in.");
    expect(plain.addressErrorText).toBeUndefined();
    expect(plain.resultLines).toEqual([]);
    expect(plain.connectedText).toBeUndefined();
    plain.dispose();
  });

  it("the connected line names the server or the endpoint, and nothing when there is none", () => {
    const line = (current?: ConnectionResult): string | undefined =>
      new ConnectionWizardViewModel({ ...DEFAULT_OPTIONS, entry: WizardEntry.Settings, ...(current ? { current } : {}) }, new FakeConnectionStore(), {
        server: new FakeServerSignIn(() => Date.now()), keys: new FakeKeyStore(),
      }).connectedText;
    expect(line(SERVER_CONNECTION)).toBe("Connected to https://ai.example.test/.");
    expect(line(ENDPOINT_CONNECTION)).toBe("Your own AI: https://api.openai.com/v1.");
    expect(line()).toBeUndefined();
  });
});
