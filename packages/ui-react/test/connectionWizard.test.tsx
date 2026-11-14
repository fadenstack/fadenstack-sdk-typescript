// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConnectionWizardViewModel,
  WizardPoint,
  WizardStep,
  englishStrings,
  germanStrings,
  type UiStrings,
  type WizardStepHandler,
} from "@fadenstack/ui";
import { ConnectionWizard } from "@fadenstack/ui-react";

import { DEFAULT_OPTIONS, FakeStep, policyOf } from "../../ui/test/wizardFakes.js";
import { ADDRESS, ALL_STEPS, Harness, reach } from "./wizardHarness.js";

const harnesses: Harness[] = [];
afterEach(() => {
  cleanup();
  for (const h of harnesses.splice(0)) h.dispose();
  vi.restoreAllMocks();
});

async function at(step: WizardStep, strings: UiStrings = englishStrings) {
  const made = await reach(step, strings);
  harnesses.push(made.h);
  return made;
}

function draw(vm: ConnectionWizardViewModel, props: Partial<Parameters<typeof ConnectionWizard>[0]> = {}) {
  return render(<ConnectionWizard wizard={vm} appName="Fadenstack Chrome" {...props} />);
}

const column = (container: HTMLElement) => container.querySelector<HTMLElement>(".fdn-wizard-column")!;

describe("ConnectionWizard: every step renders", () => {
  const languages: readonly [string, UiStrings][] = [["English", englishStrings], ["German", germanStrings]];

  describe.each(languages)("in %s", (_name, strings) => {
    it.each(ALL_STEPS)("%s", async (step) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const { vm } = await at(step, strings);
      const { container } = draw(vm);

      if (step === WizardStep.Finished) {
        expect(container.innerHTML).toBe("");
        return;
      }
      expect(vm.step).toBe(step);
      expect(column(container).textContent!.trim().length > 0 || step === WizardStep.BeforeChoice || step === WizardStep.AfterConnect).toBe(true);
      expect(container.querySelector(".fdn-wizard")!.getAttribute("lang")).toBe(strings.language);

      // Every visible input has a label; every button has a name.
      for (const field of container.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")) {
        expect(field.labels?.length ?? 0, `a label for ${field.outerHTML}`).toBeGreaterThan(0);
      }
      for (const button of container.querySelectorAll("button")) {
        const name = (button.getAttribute("aria-label") ?? button.textContent ?? "").trim();
        expect(name.length, `a name for ${button.outerHTML}`).toBeGreaterThan(0);
      }
      // Busy steps say so.
      expect(column(container).getAttribute("aria-busy")).toBe(String(vm.isBusy));
      expect(error).not.toHaveBeenCalled();
    });
  });
});

describe("ConnectionWizard: the step's texts", () => {
  it("shows the choice with its help lines, and nothing else it cannot do", async () => {
    const { vm } = await at(WizardStep.Choose);
    draw(vm);
    const s = englishStrings;
    expect(screen.getByRole("heading", { name: s.wizardChooseTitle("Fadenstack Chrome") })).toBeTruthy();
    expect(screen.getByRole("button", { name: s.wizardChooseServer }).getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText(s.wizardChooseServerHelp)).toBeTruthy();
    expect(screen.getByRole("button", { name: s.wizardChooseOwnAi })).toBeTruthy();
    expect(screen.queryByRole("button", { name: s.wizardChooseDemo })).toBeNull(); // the app has no demo
  });

  it("shows the address error in an alert", async () => {
    const { vm } = await at(WizardStep.ServerAddress);
    draw(vm);
    act(() => {
      vm.serverAddressText = "http://not-local.example.test";
    });
    fireEvent.submit(screen.getByRole("textbox").closest("form")!);
    await act(() => Promise.resolve());
    expect(screen.getByRole("alert").textContent).toBe(vm.addressErrorText);
    expect(vm.addressErrorText).toBe(englishStrings.wizardServerHttpsRequired);
  });

  it("shows the consent box unticked, the binding-version line except in German, and the search consent", async () => {
    const en = await at(WizardStep.OwnAccept);
    draw(en.vm);
    expect((screen.getByLabelText(englishStrings.wizardOwnConsent) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(englishStrings.wizardOwnBindingVersion)).toBeTruthy();
    expect(screen.getByLabelText(englishStrings.wizardOwnSearchConsent)).toBeTruthy();
    expect((screen.getByRole("button", { name: englishStrings.wizardOwnAccept }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(englishStrings.wizardOwnConsent));
    expect(en.vm.accepted).toBe(true);
    expect((screen.getByRole("button", { name: englishStrings.wizardOwnAccept }) as HTMLButtonElement).disabled).toBe(false);
    cleanup();

    const de = await at(WizardStep.OwnAccept, germanStrings);
    draw(de.vm);
    expect(screen.queryByText(germanStrings.wizardOwnBindingVersion)).toBeNull();
  });

  it("hides the search consent when the computer cannot be searched, and Read the full terms without a handler", async () => {
    const h = new Harness(englishStrings, { ...DEFAULT_OPTIONS, canSearchThisComputer: false });
    harnesses.push(h);
    await h.start();
    await h.press("chooseOwnAi");
    const open = vi.fn();
    draw(h.vm);
    expect(screen.queryByLabelText(englishStrings.wizardOwnSearchConsent)).toBeNull();
    expect(screen.queryByRole("button", { name: englishStrings.wizardOwnFullTerms })).toBeNull();
    cleanup();
    draw(h.vm, { onOpenTerms: open });
    fireEvent.click(screen.getByRole("button", { name: englishStrings.wizardOwnFullTerms }));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("lists the check's lines, and draws the model pick as a labelled select", async () => {
    const result = await at(WizardStep.OwnResult);
    draw(result.vm);
    for (const line of result.vm.resultLines) expect(screen.getByText(line)).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(result.vm.resultLines.length);
    cleanup();

    const model = await at(WizardStep.OwnModel);
    draw(model.vm);
    const select = screen.getByLabelText(englishStrings.wizardModelLabel) as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["m1", "m2"]);
    fireEvent.change(select, { target: { value: "m2" } });
    expect(model.vm.selectedModel).toBe("m2");
  });

  it("shows the code large, with Copy and Open, and the pairing's server", async () => {
    const { vm, h } = await at(WizardStep.PairCode);
    draw(vm);
    expect(screen.getByText(vm.userCode!)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: englishStrings.wizardCopyCode }));
    expect(h.clipboard.texts).toEqual([vm.userCode]);
    fireEvent.click(screen.getByRole("button", { name: englishStrings.wizardOpenPage }));
    expect(h.links.opened).toHaveLength(1);
    expect(screen.getByText(englishStrings.wizardServerAt(vm.serverUrl!.href))).toBeTruthy();
  });

  it("offers the buttons the commands allow on an error step", async () => {
    const { vm } = await at(WizardStep.Unreachable);
    draw(vm);
    const s = englishStrings;
    expect(screen.getByRole("alert").textContent).toBe(s.wizardUnreachable);
    for (const name of [s.wizardTryAgain, s.wizardChangeServer, s.wizardClose]) expect(screen.getByRole("button", { name })).toBeTruthy();
    expect(screen.queryByRole("button", { name: s.wizardNewCode })).toBeNull();
  });

  it("draws the app's own step on a busy step", async () => {
    const step = new FakeStep(WizardPoint.BeforeServerCheck);
    step.script.pending();
    const h = new Harness(englishStrings, { ...DEFAULT_OPTIONS, steps: [step] });
    harnesses.push(h);
    await h.start();
    await h.press("chooseServer");
    h.vm.serverAddressText = ADDRESS;
    await h.press("submitServer");
    expect(h.vm.step).toBe(WizardStep.AppPrecondition);
    const seen: WizardStepHandler[] = [];
    draw(h.vm, { renderAppStep: (s) => { seen.push(s); return <p>The app asks for a permission.</p>; } });
    expect(screen.getByText("The app asks for a permission.")).toBeTruthy();
    expect(seen[0]).toBe(step);
  });

  it("settings: names the connection, Remove this AI for an endpoint, and sign-out has the unticked chats box", async () => {
    const settings = await at(WizardStep.Settings);
    draw(settings.vm);
    expect(screen.getByText(settings.vm.connectedText!)).toBeTruthy();
    expect(screen.getByRole("button", { name: englishStrings.wizardSignOut })).toBeTruthy();
    cleanup();

    const out = await at(WizardStep.SignOut);
    draw(out.vm);
    expect(screen.getByRole("heading", { name: englishStrings.wizardRemoveTitle })).toBeTruthy();
    expect((screen.getByLabelText(englishStrings.wizardDeleteChats) as HTMLInputElement).checked).toBe(false);
    fireEvent.click(screen.getByLabelText(englishStrings.wizardDeleteChats));
    expect(out.vm.deleteLocalChats).toBe(true);
    expect(screen.getByRole("button", { name: englishStrings.wizardCancel })).toBeTruthy();
  });
});

describe("ConnectionWizard: no secret stays", () => {
  it("passes the password to the sign-in and leaves the input empty", async () => {
    const { vm, h } = await at(WizardStep.Password);
    const { container } = draw(vm);
    const input = screen.getByLabelText(englishStrings.wizardPassword) as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("current-password");
    fireEvent.change(screen.getByLabelText(englishStrings.wizardEmail), { target: { value: "ana@example.test" } });
    fireEvent.change(input, { target: { value: "hunter2-secret" } });
    expect(input.value).toBe("hunter2-secret");
    fireEvent.click(screen.getByRole("button", { name: englishStrings.wizardSignIn }));
    expect(input.value).toBe(""); // cleared in the same turn
    await act(() => Promise.resolve());
    expect(h.sign.passwordsTried).toEqual([{ server: `${ADDRESS}/`, email: "ana@example.test", password: "hunter2-secret" }]);
    expect(container.innerHTML).not.toContain("hunter2-secret");
    expect(JSON.stringify(Object.entries(vm))).not.toContain("hunter2-secret");
  });

  it("passes the key to the key store and leaves the input empty", async () => {
    const { vm, h } = await at(WizardStep.OwnKey);
    const { container } = draw(vm);
    const input = screen.getByLabelText(englishStrings.wizardKeyLabel) as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("off");
    fireEvent.change(input, { target: { value: "sk-secret-key" } });
    fireEvent.submit(input.closest("form")!);
    expect(input.value).toBe("");
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(h.keys.saved.map((k) => k.key)).toEqual(["sk-secret-key"]);
    expect(container.innerHTML).not.toContain("sk-secret-key");
    expect(vm.keySet).toBe(true);
  });
});

describe("ConnectionWizard: the user gesture", () => {
  it("runs the app's step before the check inside the click of Use this, before any await", async () => {
    const step = new FakeStep(WizardPoint.BeforeEndpointCheck);
    step.script.pending();
    let ran = false;
    step.onRun = () => {
      ran = true;
    };
    const h = new Harness(englishStrings, { ...DEFAULT_OPTIONS, steps: [step] });
    harnesses.push(h);
    await h.start();
    await h.press("chooseOwnAi");
    h.vm.accepted = true;
    await h.press("accept");
    expect(h.vm.step).toBe(WizardStep.OwnPick);
    draw(h.vm);
    fireEvent.change(screen.getByLabelText(englishStrings.wizardOwnAddress), { target: { value: "https://api.example.test/v1" } });
    expect(ran).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: englishStrings.wizardOwnUse }));
    expect(ran).toBe(true); // no await between the click and the app's step
  });

  it("runs the app's step before the server check inside the submit", async () => {
    const step = new FakeStep(WizardPoint.BeforeServerCheck);
    step.script.pending();
    let ran = false;
    step.onRun = () => {
      ran = true;
    };
    const h = new Harness(englishStrings, { ...DEFAULT_OPTIONS, steps: [step] });
    harnesses.push(h);
    await h.start();
    await h.press("chooseServer");
    draw(h.vm);
    fireEvent.change(screen.getByLabelText(englishStrings.wizardServerLabel), { target: { value: ADDRESS } });
    fireEvent.click(screen.getByRole("button", { name: englishStrings.wizardContinue }));
    expect(ran).toBe(true);
  });
});

describe("ConnectionWizard: the keyboard", () => {
  it("submits the address with its form (Enter in the field), the e-mail and password, and the key", async () => {
    for (const [step, label] of [
      [WizardStep.ServerAddress, englishStrings.wizardServerLabel],
      [WizardStep.Password, englishStrings.wizardEmail],
      [WizardStep.OwnKey, englishStrings.wizardKeyLabel],
      [WizardStep.OwnPick, englishStrings.wizardOwnAddress],
    ] as const) {
      const { vm } = await at(step);
      draw(vm);
      const form = screen.getByLabelText(label).closest("form")!;
      expect(form, `a form for ${step}`).toBeTruthy();
      // A form with a submit button is what the browser submits on Enter.
      expect(form.querySelector('button[type="submit"]'), `a submit button for ${step}`).toBeTruthy();
      cleanup();
    }
    const { vm, h } = await at(WizardStep.ServerAddress);
    draw(vm);
    fireEvent.change(screen.getByLabelText(englishStrings.wizardServerLabel), { target: { value: ADDRESS } });
    fireEvent.submit(screen.getByLabelText(englishStrings.wizardServerLabel).closest("form")!);
    await act(() => Promise.resolve());
    expect(h.sign.checked).toEqual([`${ADDRESS}/`]);
  });

  it("Escape cancels a busy step", async () => {
    const { vm } = await at(WizardStep.Checking);
    const { container } = draw(vm);
    expect(vm.can.cancel).toBe(true);
    fireEvent.keyDown(column(container), { key: "Escape" });
    expect(vm.step).toBe(WizardStep.ServerAddress);
  });

  it("Escape goes back where Back is available, and does nothing where neither is", async () => {
    const pick = await at(WizardStep.OwnPick);
    const { container } = draw(pick.vm);
    fireEvent.keyDown(column(container), { key: "Escape" });
    expect(pick.vm.step).toBe(WizardStep.OwnAccept);
    cleanup();

    const choose = await at(WizardStep.Choose);
    const second = draw(choose.vm);
    fireEvent.keyDown(column(second.container), { key: "Escape" });
    expect(choose.vm.step).toBe(WizardStep.Choose);
  });

  it("moves the focus to the field, or to the title, when the step changes", async () => {
    const { vm } = await at(WizardStep.Choose);
    draw(vm);
    expect(document.activeElement).toBe(screen.getByRole("heading"));
    act(() => vm.chooseServer());
    expect(document.activeElement).toBe(screen.getByLabelText(englishStrings.wizardServerLabel));
    act(() => vm.back());
    expect(document.activeElement).toBe(screen.getByRole("heading"));
  });

  it("shows a locked address read-only with its note, and focuses the title, not the field", async () => {
    const policy = policyOf({ server: new URL(`${ADDRESS}/`) });
    const h = new Harness(englishStrings, { ...DEFAULT_OPTIONS, policy });
    harnesses.push(h);
    await h.start();
    expect(h.vm.step).toBe(WizardStep.PairCode); // the policy's server goes straight to the code
    await h.press("cancel"); // ... and Cancel is the way back to its (locked) address
    expect(h.vm.step).toBe(WizardStep.ServerAddress);
    draw(h.vm);
    const field = screen.getByLabelText(englishStrings.wizardServerLabel) as HTMLInputElement;
    expect(field.readOnly).toBe(true);
    expect(field.value).toBe(`${ADDRESS}/`);
    expect(screen.getByText(englishStrings.wizardServerLocked)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("heading"));
  });
});

describe("ConnectionWizard: the countdown", () => {
  it("is a timer that follows the countdown without announcing every second", async () => {
    const { vm, h } = await at(WizardStep.PairCode);
    draw(vm);
    const first = vm.waitingText!;
    expect(first).toBe(englishStrings.wizardWaiting(vm.timeLeftMs));
    const region = screen.getByRole("timer");
    expect(region.getAttribute("aria-live")).toBe("off");
    expect(region.textContent).toBe(first);
    act(() => h.clock.advance(1000));
    expect(vm.waitingText).not.toBe(first);
    expect(region.textContent).toBe(vm.waitingText);
  });

  it("holds the busy line of a busy step and the signed-in text", async () => {
    const busy = await at(WizardStep.Checking);
    draw(busy.vm);
    expect(screen.getByText(englishStrings.wizardChecking).closest("[aria-live]")!.getAttribute("aria-live")).toBe("polite");
    cleanup();
    const signed = await at(WizardStep.SignedIn);
    draw(signed.vm);
    expect(screen.getByText(signed.vm.signedInText).closest("[aria-live]")!.getAttribute("aria-live")).toBe("polite");
  });

  it("marks an error as an alert", async () => {
    const { vm } = await at(WizardStep.OwnFailed);
    draw(vm);
    expect(screen.getByRole("alert").textContent).toBe(vm.problemText);
  });
});
