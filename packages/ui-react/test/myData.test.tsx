// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MyDataSettingsViewModel, builtInStrings, type MyDataSaveRequest } from "@fadenstack/ui";
import { MyDataSettings } from "@fadenstack/ui-react";

import { APP_A, APP_B, FakeMyData, type ScenarioName } from "../../ui/test/myDataFakes.js";

// The "Your data" control in the React skin, over the real view model: every state in the five languages, the names screen readers need,
// the dialog that takes the focus, and the buttons that do what the view model says.

afterEach(() => cleanup());

const LANGUAGES = ["en", "de", "fr", "es", "zh-Hans"] as const;

function show(scenario: ScenarioName, language: string = "en") {
  const source = new FakeMyData(scenario);
  const strings = builtInStrings[language]!;
  const vm = new MyDataSettingsViewModel({ source, strings: () => strings });
  const saved: MyDataSaveRequest[] = [];
  vm.onSaveRequest((r) => saved.push(r));
  const view = render(<MyDataSettings settings={vm} />);
  return { source, vm, strings, view, saved };
}

const press = async (name: string) => { await act(async () => { fireEvent.click(screen.getByRole("button", { name })); }); };

describe("the Your data control (React)", () => {
  describe.each(LANGUAGES)("in %s", (language) => {
    it("draws the idle state with four named actions", () => {
      const { strings, view } = show("others", language);
      expect(screen.getByRole("heading", { level: 2, name: strings.myDataTitle })).toBeTruthy();
      expect(view.container.querySelector(".fdn-wizard")!.getAttribute("lang")).toBe(strings.language);
      for (const [visible, name] of [[strings.myDataExport, strings.myDataExportName], [strings.myDataRemove, strings.myDataRemoveName],
        [strings.myDataExportAll, strings.myDataExportAllName], [strings.myDataRemoveAll, strings.myDataRemoveAllName]] as const) {
        const button = screen.getByRole("button", { name }) as HTMLButtonElement;
        expect(button.textContent).toBe(visible);
        expect(button.disabled).toBe(false);
        expect(name.toLowerCase()).toContain(visible.toLowerCase());
      }
      expect(screen.queryByRole("alertdialog")).toBeNull();
    });

    it("asks for this app with other apps, and the dialog takes the focus on its safe answer", async () => {
      const { strings } = show("shared-agent", language);
      await press(strings.myDataRemoveName);
      const dialog = screen.getByRole("alertdialog");
      expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
      expect(dialog.textContent).toContain(APP_A);
      expect(dialog.textContent).toContain(APP_B);
      expect(document.activeElement).toBe(screen.getByRole("button", { name: strings.myDataCancelName }));
      expect(screen.getByRole("button", { name: strings.myDataConfirmRemoveName }).textContent).toBe(strings.myDataConfirmRemove);
      expect(screen.queryByRole("button", { name: strings.myDataExportName })).toBeNull();
    });

    it("asks for this app alone with the words for everything going", async () => {
      const { strings, vm } = show("alone", language);
      await press(strings.myDataRemoveName);
      expect(screen.getByRole("alertdialog").textContent).toContain(strings.myDataConfirmNoOtherApps);
      expect(vm.otherApps).toEqual([]);
    });

    it("asks for all with the list of the apps it affects", async () => {
      const { strings } = show("others", language);
      await press(strings.myDataRemoveAllName);
      const text = screen.getByRole("alertdialog").textContent!;
      expect(text).toContain(strings.myDataConfirmAllTitle);
      for (const name of [APP_A, APP_B, "excel-assistant"]) expect(text).toContain(name);
      expect(screen.getByRole("button", { name: strings.myDataConfirmRemoveAllName }).textContent).toBe(strings.myDataConfirmRemoveAll);
    });

    it("says it is busy, then done with what stayed", async () => {
      const { strings, source } = show("others", language);
      let release!: () => void;
      source.gate = new Promise<void>((resolve) => { release = resolve; });
      await press(strings.myDataRemoveName);
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: strings.myDataConfirmRemoveName })); });
      expect(screen.getByRole("status").textContent).toBe(strings.myDataWorking);
      expect((screen.getByRole("button", { name: strings.myDataRemoveName }) as HTMLButtonElement).disabled).toBe(true);
      expect(document.querySelector(".fdn-skills-column")!.getAttribute("aria-busy")).toBe("true");
      await act(async () => { release(); });
      expect(screen.getByRole("status").textContent).toContain(strings.myDataRemoved(APP_A));
      expect(screen.getByRole("status").textContent).toContain(APP_B);
      expect((screen.getByRole("button", { name: strings.myDataRemoveName }) as HTMLButtonElement).disabled).toBe(false);
    });

    it("shows an error as a sentence in an alert, without the exception's text", async () => {
      const { strings, source } = show("others", language);
      source.failExport = true;
      await press(strings.myDataExportName);
      expect(screen.getByRole("alert").textContent).toBe(strings.myDataExportFailed);
      source.failRemove = true;
      await press(strings.myDataRemoveAllName);
      await press(strings.myDataConfirmRemoveAllName);
      expect(screen.getByRole("alert").textContent).toBe(strings.myDataRemoveFailed);
      expect(document.body.textContent).not.toContain("boom");
    });
  });

  it("Cancel and Escape say no, and the focus goes back to the first action", async () => {
    const { strings, source } = show("others");
    await press(strings.myDataRemoveName);
    await press(strings.myDataCancelName);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: strings.myDataExportName }));
    await press(strings.myDataRemoveAllName);
    await act(async () => { fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" }); });
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(source.calls).toEqual([]);
  });

  it("Yes removes this app's data only, and the result line names who kept the shared data", async () => {
    const { strings, source } = show("others");
    await press(strings.myDataRemoveName);
    await press(strings.myDataConfirmRemoveName);
    expect(source.calls).toEqual(["remove:thisApp"]);
    expect(screen.getByRole("status").textContent).toContain("Skills, MCP servers, keys and provenance records stayed");
  });

  it("an export hands the app a document to save and says its name", async () => {
    const { strings, saved } = show("others");
    await press(strings.myDataExportAllName);
    expect(saved).toHaveLength(1);
    expect(saved[0]!.scope).toBe("allApps");
    expect(screen.getByRole("status").textContent).toBe(strings.myDataExported(saved[0]!.fileName));
  });
});
