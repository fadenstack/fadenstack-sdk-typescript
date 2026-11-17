// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EndpointDialect } from "@fadenstack/client";
import { ApprovalDecision } from "@fadenstack/agents";
import { OpenAiFake } from "@fadenstack/testing";
import { AgentChatViewModel, ApprovalBroker, MyDataSettingsViewModel, StopEverythingViewModel, immediateScheduler } from "@fadenstack/ui";

import { browserChatServices } from "@fadenstack/ui-web";

import { Page } from "../src/page.js";
import { Notes, buildSampleAgent } from "../src/sample.js";

afterEach(cleanup);

// The page against the sample's agent on the testing package's fakes: the header has one control named "Settings", and the drawer
// opens from that menu.
describe("the standalone web sample's page", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function show(): Promise<void> {
    const fake = new OpenAiFake();
    const notes = new Notes();
    const approvals = new ApprovalBroker();
    const agent = buildSampleAgent({
      endpoint: { baseUrl: "http://localhost:11434/v1", model: "qwen3:14b", dialect: EndpointDialect.ollama, fetch: fake.fetch },
      notes,
      approvals: () => Promise.resolve(ApprovalDecision.approve()),
    });
    const chat = new AgentChatViewModel(agent, approvals, { ...browserChatServices(), scheduler: immediateScheduler, automaticLanguage: ["en-US"], locale: "en-US" });
    await act(() => chat.initialize());
    const myData = new MyDataSettingsViewModel({ agent, strings: () => chat.strings });
    await act(() => myData.load());
    const stop = new StopEverythingViewModel({ agents: () => [agent], strings: () => chat.strings });
    render(<Page running={{ agent, chat, stop, myData }} notes={notes} />);
  }

  it("has one control named Settings in the header", async () => {
    await show();

    expect(screen.getAllByRole("button", { name: "Settings" })).toHaveLength(1);
  });

  it("opens the drawer with the person's data from the Settings menu, and closes the menu", async () => {
    await show();
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Your data in this browser" }));
    });

    expect(screen.getByRole("dialog", { name: "Your data in this browser" })).toBeTruthy();
    expect(screen.queryByRole("menu", { name: "Settings" })).toBeNull();
    expect(screen.getByRole("button", { name: /Remove my data/ })).toBeTruthy();
  });
});
