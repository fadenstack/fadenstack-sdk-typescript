// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore } from "@fadenstack/agents";
import {
  AgentChatViewModel, ApprovalBroker, ContentLoggingBandViewModel, ContentLoggingSettingsViewModel, MemoryClipboard, builtInStrings, immediateScheduler,
} from "@fadenstack/ui";
import { ChatPanel, ContentLoggingBand, ContentLoggingSettings } from "@fadenstack/ui-react";
import { FakeGateway } from "@fadenstack/testing";
import { testServices } from "./services.js";

import { FakeContentLogging, STATES } from "../../ui/test/contentLoggingFakes.js";

// Content logging in the React skin, over the real view models: the setting in every state in the five languages, the names screen readers
// need, the buttons that do what the view model says, and the band.

afterEach(() => cleanup());

const LANGUAGES = ["en", "de", "fr", "es", "zh-Hans"] as const;
const NAMES = Object.keys(STATES) as (keyof typeof STATES)[];

function show(state: keyof typeof STATES, language: string = "en") {
  const source = STATES[state]();
  const strings = builtInStrings[language]!;
  const vm = new ContentLoggingSettingsViewModel({ source, strings: () => strings });
  const view = render(<ContentLoggingSettings settings={vm} />);
  return { source, vm, strings, view };
}

describe("the content logging setting (React)", () => {
  describe.each(LANGUAGES)("in %s", (language) => {
    it.each(NAMES)("draws the %s state", (state) => {
      const { strings, view, vm } = show(state, language);
      if (state === "unavailable") {
        expect(view.container.textContent).toBe("");
        return;
      }
      expect(screen.getByRole("heading", { name: strings.contentLoggingTitle })).toBeTruthy();
      expect(view.container.querySelector(".fdn-wizard")!.getAttribute("lang")).toBe(strings.language);
      expect(view.container.textContent).toContain(strings.contentLoggingIntro);
      const select = screen.getByLabelText(strings.contentLoggingDuration) as HTMLSelectElement;
      expect([...select.options].map((o) => o.text)).toEqual([strings.contentLoggingOneHour, strings.contentLoggingFourHours, strings.contentLoggingDay]);
      expect(select.disabled).toBe(state === "on");
      expect((screen.getByRole("button", { name: strings.contentLoggingStartName }) as HTMLButtonElement).disabled).toBe(state === "on");
      expect((screen.getByRole("button", { name: strings.contentLoggingStopName }) as HTMLButtonElement).disabled).toBe(state === "off");
      expect(view.container.querySelector("[role=status]")!.textContent).toBe(state === "on" ? vm.onUntilText : "");
    });
  });

  it("Start switches it on for the chosen time and Stop switches it off", () => {
    const { source, strings } = show("off");
    fireEvent.change(screen.getByLabelText(strings.contentLoggingDuration), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("button", { name: strings.contentLoggingStartName }));

    expect(source.started).toEqual([4 * 60 * 60 * 1000]);
    expect((screen.getByRole("button", { name: strings.contentLoggingStopName }) as HTMLButtonElement).disabled).toBe(false);
    expect(document.querySelector("[role=status]")!.textContent).toMatch(/^On until /);

    fireEvent.click(screen.getByRole("button", { name: strings.contentLoggingStopName }));
    expect(source.stops).toBe(1);
    expect(document.querySelector("[role=status]")!.textContent).toBe("");
  });

  it("disappears when the policy forbids it later", () => {
    const { source, view } = show("off");
    act(() => { source.canStart = false; source.endByItself(); });
    expect(view.container.textContent).toBe("");
  });
});

describe("the content logging band (React)", () => {
  it("is not there while off; while on it says until when and Stop ends it", () => {
    const source = new FakeContentLogging(true);
    const band = new ContentLoggingBandViewModel({ source });
    const view = render(<ContentLoggingBand band={band} />);
    expect(view.container.textContent).toBe("");

    act(() => source.start(60 * 60 * 1000));
    const strings = builtInStrings.en!;
    expect(view.container.querySelector("[role=status]")!.textContent).toBe(band.text + strings.markerStop);
    expect(band.text.startsWith("Content logging is on until ")).toBe(true);
    const stop = screen.getByRole("button", { name: strings.contentLoggingStopName });
    expect(stop.textContent).toBe("Stop");

    fireEvent.click(stop);
    expect(source.stops).toBe(1);
    expect(view.container.textContent).toBe("");
  });

  it("says its texts in every language", () => {
    for (const language of LANGUAGES) {
      const source = new FakeContentLogging(true, true, Date.now() + 3600000);
      const strings = builtInStrings[language]!;
      const band = new ContentLoggingBandViewModel({ source, strings: () => strings });
      const view = render(<ContentLoggingBand band={band} />);
      expect(screen.getByRole("button", { name: strings.contentLoggingStopName }).textContent).toBe(strings.markerStop);
      expect(view.container.textContent).toContain(band.text);
      cleanup();
    }
  });
});

describe("the content logging band in the chat panel (React)", () => {
  it("shows above the composer while content logging is on, and its Stop ends it", async () => {
    const gateway = new FakeGateway({ agents: [{ slug: "page", name: "Page assistant" }], model: () => ({ text: "ok" }) });
    const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
    await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
    const approvals = new ApprovalBroker();
    const agent = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals).useHookContent().build();
    const chat = new AgentChatViewModel(agent, approvals, { ...testServices(), scheduler: immediateScheduler, clipboard: new MemoryClipboard() });
    await act(() => chat.initialize());
    render(<ChatPanel chat={chat} />);
    expect(document.querySelector(".fdn-content-logging-band")).toBeNull(); // offered is not on

    act(() => agent.startContentLogging(60 * 60 * 1000));
    const band = document.querySelector(".fdn-content-logging-band")!;
    expect(band.textContent).toContain("Prompts and answers are written to the app's logs.");
    expect(band.compareDocumentPosition(document.querySelector(".fdn-composer")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Stop content logging" }));
    expect(agent.contentLogging.isOn).toBe(false);
    expect(document.querySelector(".fdn-content-logging-band")).toBeNull();
  });
});
