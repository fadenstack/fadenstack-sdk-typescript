// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { h as vnode } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WizardPoint,
  WizardStep,
  englishStrings,
  germanStrings,
  type ConnectionWizardViewModel,
  type UiStrings,
  type WizardStepHandler,
} from "@fadenstack/ui";
import { ConnectionWizard } from "@fadenstack/ui-vue";

import { DEFAULT_OPTIONS, FakeStep, policyOf } from "../../ui/test/wizardFakes.js";
import { ADDRESS, ALL_STEPS, Harness, reach } from "../../ui-react/test/wizardHarness.js";

// The same checks as @fadenstack/ui-react's connectionWizard.test.tsx, on the Vue skin (parity), against a real view model on fakes.

let wrappers: VueWrapper[] = [];
const harnesses: Harness[] = [];
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
  for (const h of harnesses.splice(0)) h.dispose();
  vi.restoreAllMocks();
});

async function at(step: WizardStep, strings: UiStrings = englishStrings) {
  const made = await reach(step, strings);
  harnesses.push(made.h);
  return made;
}

function draw(vm: ConnectionWizardViewModel, options: { onOpenTerms?: () => void; slots?: Record<string, (props: { step: WizardStepHandler }) => unknown> } = {}) {
  const wrapper = mount(ConnectionWizard, {
    props: { wizard: vm, appName: "Fadenstack Chrome", ...(options.onOpenTerms ? { onOpenTerms: options.onOpenTerms } : {}) },
    slots: options.slots as never,
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  return wrapper;
}

const column = (w: VueWrapper) => w.get(".fdn-wizard-column");
const field = (w: VueWrapper, label: string): HTMLInputElement => {
  const labelled = [...w.element.querySelectorAll("label")].find((l) => l.textContent === label);
  if (!labelled) throw new Error(`no label ${label}`);
  return (w.element as Element).querySelector(`[id="${labelled.htmlFor}"]`) as HTMLInputElement; // each mounted app numbers its ids from 0
};
const nameOf = (b: Element): string => {
  const by = b.getAttribute("aria-labelledby");
  const text = by ? by.split(" ").map((id) => b.querySelector(`[id="${id}"]`)?.textContent ?? "").join(" ") : (b.getAttribute("aria-label") ?? b.textContent ?? "");
  return text.trim();
};
const button = (w: VueWrapper, name: string): HTMLButtonElement => {
  const found = [...(w.element as Element).querySelectorAll("button")].find((b) => nameOf(b) === name);
  if (!found) throw new Error(`no button ${name}`);
  return found;
};
const hasButton = (w: VueWrapper, name: string): boolean => [...(w.element as Element).querySelectorAll("button")].some((b) => nameOf(b) === name);
const type = async (input: HTMLInputElement | HTMLSelectElement, value: string) => {
  input.value = value;
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  await flushPromises();
};
const click = async (el: HTMLElement) => {
  el.click();
  await flushPromises();
};

describe("ConnectionWizard (Vue): every step renders", () => {
  const languages: readonly [string, UiStrings][] = [["English", englishStrings], ["German", germanStrings]];

  describe.each(languages)("in %s", (_name, strings) => {
    it.each(ALL_STEPS)("%s", async (step) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const { vm } = await at(step, strings);
      const wrapper = draw(vm);

      if (step === WizardStep.Finished) {
        expect(wrapper.find(".fdn-wizard").exists()).toBe(false);
        return;
      }
      expect(vm.step).toBe(step);
      expect(column(wrapper).text().length > 0 || step === WizardStep.BeforeChoice || step === WizardStep.AfterConnect).toBe(true);
      expect(wrapper.get(".fdn-wizard").attributes("lang")).toBe(strings.language);

      for (const input of (wrapper.element as Element).querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")) {
        expect(input.labels?.length ?? 0, `a label for ${input.outerHTML}`).toBeGreaterThan(0);
      }
      for (const b of (wrapper.element as Element).querySelectorAll("button")) {
        const name = nameOf(b);
        expect(name.length, `a name for ${b.outerHTML}`).toBeGreaterThan(0);
      }
      expect(column(wrapper).attributes("aria-busy")).toBe(String(vm.isBusy));
      expect(error).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    });
  });
});

describe("ConnectionWizard (Vue): the step's texts", () => {
  it("shows the choice with its help lines", async () => {
    const { vm } = await at(WizardStep.Choose);
    const w = draw(vm);
    const s = englishStrings;
    expect(w.get("h2").text()).toBe(s.wizardChooseTitle("Fadenstack Chrome"));
    expect(button(w, s.wizardChooseServer).getAttribute("aria-describedby")).toBeTruthy();
    expect(w.text()).toContain(s.wizardChooseServerHelp);
    expect(hasButton(w, s.wizardChooseOwnAi)).toBe(true);
    expect(hasButton(w, s.wizardChooseDemo)).toBe(false);
  });

  it("shows the address error in an alert", async () => {
    const { vm } = await at(WizardStep.ServerAddress);
    const w = draw(vm);
    await type(field(w, englishStrings.wizardServerLabel), "http://not-local.example.test");
    await w.get("form").trigger("submit");
    await flushPromises();
    expect(w.get('[role="alert"]').text()).toBe(englishStrings.wizardServerHttpsRequired);
  });

  it("shows the consent box unticked, the binding-version line except in German, and the search consent", async () => {
    const en = await at(WizardStep.OwnAccept);
    const w = draw(en.vm);
    expect(field(w, englishStrings.wizardOwnConsent).checked).toBe(false);
    expect(w.text()).toContain(englishStrings.wizardOwnBindingVersion);
    expect(field(w, englishStrings.wizardOwnSearchConsent)).toBeTruthy();
    expect(button(w, englishStrings.wizardOwnAccept).disabled).toBe(true);
    await field(w, englishStrings.wizardOwnConsent).click();
    await flushPromises();
    expect(en.vm.accepted).toBe(true);
    expect(button(w, englishStrings.wizardOwnAccept).disabled).toBe(false);

    const de = await at(WizardStep.OwnAccept, germanStrings);
    expect(draw(de.vm).text()).not.toContain(germanStrings.wizardOwnBindingVersion);
  });

  it("shows Read the full terms only with a listener, and emits open-terms", async () => {
    const { vm } = await at(WizardStep.OwnAccept);
    expect(hasButton(draw(vm), englishStrings.wizardOwnFullTerms)).toBe(false);
    const open = vi.fn();
    const w = draw(vm, { onOpenTerms: open });
    await click(button(w, englishStrings.wizardOwnFullTerms));
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("hides the search consent when the computer cannot be searched", async () => {
    const h = new Harness(englishStrings, { ...DEFAULT_OPTIONS, canSearchThisComputer: false });
    harnesses.push(h);
    await h.start();
    await h.press("chooseOwnAi");
    expect(draw(h.vm).text()).not.toContain(englishStrings.wizardOwnSearchConsent);
  });

  it("lists the check's lines, and draws the model pick as a labelled select", async () => {
    const result = await at(WizardStep.OwnResult);
    const w = draw(result.vm);
    expect(w.findAll("li").map((li) => li.text())).toEqual([...result.vm.resultLines]);

    const model = await at(WizardStep.OwnModel);
    const mw = draw(model.vm);
    const select = field(mw, englishStrings.wizardModelLabel) as unknown as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(["m1", "m2"]);
    await type(select, "m2");
    expect(model.vm.selectedModel).toBe("m2");
  });

  it("shows the code, with Copy and Open, and the pairing's server", async () => {
    const { vm, h } = await at(WizardStep.PairCode);
    const w = draw(vm);
    expect(w.get("code").text()).toBe(vm.userCode);
    await click(button(w, englishStrings.wizardCopyCode));
    expect(h.clipboard.texts).toEqual([vm.userCode]);
    await click(button(w, englishStrings.wizardOpenPage));
    expect(h.links.opened).toHaveLength(1);
    expect(w.text()).toContain(englishStrings.wizardServerAt(vm.serverUrl!.href));
  });

  it("offers the buttons the commands allow on an error step", async () => {
    const { vm } = await at(WizardStep.Unreachable);
    const w = draw(vm);
    const s = englishStrings;
    expect(w.get('[role="alert"]').text()).toBe(s.wizardUnreachable);
    for (const name of [s.wizardTryAgain, s.wizardChangeServer, s.wizardClose]) expect(hasButton(w, name)).toBe(true);
    expect(hasButton(w, s.wizardNewCode)).toBe(false);
  });

  it("draws the app's own step in the app-step slot on a busy step", async () => {
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
    const w = draw(h.vm, { slots: { "app-step": (p) => { seen.push(p.step); return vnode("p", "The app asks for a permission."); } } });
    expect(w.text()).toContain("The app asks for a permission.");
    expect(seen[0]).toBe(step);
  });

  it("settings and sign-out", async () => {
    const settings = await at(WizardStep.Settings);
    const w = draw(settings.vm);
    expect(w.text()).toContain(settings.vm.connectedText!);
    expect(hasButton(w, englishStrings.wizardSignOut)).toBe(true);

    const out = await at(WizardStep.SignOut);
    const ow = draw(out.vm);
    expect(ow.get("h2").text()).toBe(englishStrings.wizardRemoveTitle);
    expect(field(ow, englishStrings.wizardDeleteChats).checked).toBe(false);
    await field(ow, englishStrings.wizardDeleteChats).click();
    await flushPromises();
    expect(out.vm.deleteLocalChats).toBe(true);
    expect(hasButton(ow, englishStrings.wizardCancel)).toBe(true);
  });
});

describe("ConnectionWizard (Vue): no secret stays", () => {
  it("passes the password to the sign-in and leaves the input empty", async () => {
    const { vm, h } = await at(WizardStep.Password);
    const w = draw(vm);
    const input = field(w, englishStrings.wizardPassword);
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("current-password");
    await type(field(w, englishStrings.wizardEmail), "ana@example.test");
    input.value = "hunter2-secret";
    await w.get("form").trigger("submit");
    expect(input.value).toBe(""); // cleared in the same turn
    await flushPromises();
    expect(h.sign.passwordsTried).toEqual([{ server: `${ADDRESS}/`, email: "ana@example.test", password: "hunter2-secret" }]);
    expect(w.html()).not.toContain("hunter2-secret");
    expect(JSON.stringify(Object.entries(vm))).not.toContain("hunter2-secret");
  });

  it("passes the key to the key store and leaves the input empty", async () => {
    const { vm, h } = await at(WizardStep.OwnKey);
    const w = draw(vm);
    const input = field(w, englishStrings.wizardKeyLabel);
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("off");
    input.value = "sk-secret-key";
    await w.get("form").trigger("submit");
    expect(input.value).toBe("");
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.keys.saved.map((k) => k.key)).toEqual(["sk-secret-key"]);
    expect(w.html()).not.toContain("sk-secret-key");
    expect(vm.keySet).toBe(true);
  });
});

describe("ConnectionWizard (Vue): the user gesture", () => {
  it("runs the app's step before the check inside the submit of Use this, before any await", async () => {
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
    const w = draw(h.vm);
    await type(field(w, englishStrings.wizardOwnAddress), "https://api.example.test/v1");
    expect(ran).toBe(false);
    button(w, englishStrings.wizardOwnUse).click(); // not awaited: read right after the click
    expect(ran).toBe(true);
  });
});

describe("ConnectionWizard (Vue): the keyboard", () => {
  it("has a form with a submit button where Enter submits", async () => {
    for (const [step, label] of [
      [WizardStep.ServerAddress, englishStrings.wizardServerLabel],
      [WizardStep.Password, englishStrings.wizardEmail],
      [WizardStep.OwnKey, englishStrings.wizardKeyLabel],
      [WizardStep.OwnPick, englishStrings.wizardOwnAddress],
    ] as const) {
      const { vm } = await at(step);
      const w = draw(vm);
      const form = field(w, label).closest("form");
      expect(form, `a form for ${step}`).toBeTruthy();
      expect(form!.querySelector('button[type="submit"]'), `a submit button for ${step}`).toBeTruthy();
    }
    const { vm, h } = await at(WizardStep.ServerAddress);
    const w = draw(vm);
    await type(field(w, englishStrings.wizardServerLabel), ADDRESS);
    await w.get("form").trigger("submit");
    await flushPromises();
    expect(h.sign.checked).toEqual([`${ADDRESS}/`]);
  });

  it("Escape cancels a busy step", async () => {
    const { vm } = await at(WizardStep.Checking);
    const w = draw(vm);
    await column(w).trigger("keydown", { key: "Escape" });
    expect(vm.step).toBe(WizardStep.ServerAddress);
  });

  it("Escape goes back where Back is available, and does nothing where neither is", async () => {
    const pick = await at(WizardStep.OwnPick);
    await column(draw(pick.vm)).trigger("keydown", { key: "Escape" });
    expect(pick.vm.step).toBe(WizardStep.OwnAccept);

    const choose = await at(WizardStep.Choose);
    await column(draw(choose.vm)).trigger("keydown", { key: "Escape" });
    expect(choose.vm.step).toBe(WizardStep.Choose);
  });

  it("moves the focus to the field, or to the title, when the step changes", async () => {
    const { vm } = await at(WizardStep.Choose);
    const w = draw(vm);
    await flushPromises();
    expect(document.activeElement).toBe(w.get("h2").element);
    vm.chooseServer();
    await flushPromises();
    expect(document.activeElement).toBe(field(w, englishStrings.wizardServerLabel));
    vm.back();
    await flushPromises();
    expect(document.activeElement).toBe(w.get("h2").element);
  });

  it("shows a locked address read-only with its note, and focuses the title, not the field", async () => {
    const policy = policyOf({ server: new URL(`${ADDRESS}/`) });
    const h = new Harness(englishStrings, { ...DEFAULT_OPTIONS, policy });
    harnesses.push(h);
    await h.start();
    await h.press("cancel");
    expect(h.vm.step).toBe(WizardStep.ServerAddress);
    const w = draw(h.vm);
    await flushPromises();
    const input = field(w, englishStrings.wizardServerLabel);
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe(`${ADDRESS}/`);
    expect(w.text()).toContain(englishStrings.wizardServerLocked);
    expect(document.activeElement).toBe(w.get("h2").element);
  });
});

describe("ConnectionWizard (Vue): the countdown", () => {
  it("is a timer that follows the countdown without announcing every second", async () => {
    const { vm, h } = await at(WizardStep.PairCode);
    const w = draw(vm);
    const first = vm.waitingText!;
    const region = w.get('[role="timer"]');
    expect(region.attributes("aria-live")).toBe("off");
    expect(region.text()).toBe(first);
    h.clock.advance(1000);
    await flushPromises();
    expect(vm.waitingText).not.toBe(first);
    expect(region.text()).toBe(vm.waitingText);
  });

  it("holds the busy line and the signed-in text", async () => {
    const busy = await at(WizardStep.Checking);
    expect(draw(busy.vm).get('[aria-live="polite"]').text()).toBe(englishStrings.wizardChecking);
    const signed = await at(WizardStep.SignedIn);
    expect(draw(signed.vm).get('[aria-live="polite"]').text()).toBe(signed.vm.signedInText);
  });

  it("marks an error as an alert", async () => {
    const { vm } = await at(WizardStep.OwnFailed);
    expect(draw(vm).get('[role="alert"]').text()).toBe(vm.problemText);
  });
});
