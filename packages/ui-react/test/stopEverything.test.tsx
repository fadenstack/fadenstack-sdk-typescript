// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore } from "@fadenstack/agents";
import { AgentChatViewModel, ApprovalBroker, StopEverythingViewModel, builtInStrings, immediateScheduler } from "@fadenstack/ui";
import { ChatPanel, StopEverythingButton } from "@fadenstack/ui-react";
import { FakeGateway } from "@fadenstack/testing";
import { testServices } from "./services.js";

// "Stop everything" and the notice of an agent the organisation turned off, in the React skin, over the real view models. The Vue skin's
// stopEverything.test.ts says the same.

afterEach(() => cleanup());

const LANGUAGES = ["en", "de", "fr", "es", "zh-Hans"] as const;

async function agentOn(off: boolean) {
  const gateway = new FakeGateway({ agents: [{ slug: "page", name: "Page" }] });
  if (off) gateway.turnOff();
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const approvals = new ApprovalBroker();
  const agent = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals).build();
  return { gateway, agent, approvals };
}

describe.each(LANGUAGES)("in %s", (language) => {
  const strings = builtInStrings[language]!;

  it("the chat shows the notice and Check again, disables the composer, and clears when the agent is back", async () => {
    const { gateway, agent, approvals } = await agentOn(true);
    const chat = new AgentChatViewModel(agent, approvals, { ...testServices(), scheduler: immediateScheduler });
    await act(async () => { await chat.initialize(); await chat.setLanguage(language); });
    const view = render(<ChatPanel chat={chat} />);

    const notice = view.container.querySelector(".fdn-agent-off")!;
    expect(notice.textContent).toContain(strings.agentTurnedOff);
    expect(notice.getAttribute("role")).toBe("status");
    const check = screen.getByRole("button", { name: strings.agentTurnedOffCheckAgain });
    expect(check.textContent).toBe(strings.agentTurnedOffCheckAgain);
    expect((view.container.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(true);
    expect(view.container.querySelector(".fdn-grants-off")!.textContent).toBe(strings.grantsEndedByOff);

    gateway.turnOn();
    await act(async () => { fireEvent.click(check); });
    await waitFor(() => expect(view.container.querySelector(".fdn-agent-off")).toBeNull());
    expect((view.container.querySelector("textarea") as HTMLTextAreaElement).disabled).toBe(false);
    chat.dispose();
  });

  it("the stop button has its name and tooltip, stops with no confirmation and says what it did", async () => {
    const { agent } = await agentOn(false);
    await agent.start();
    const model = new StopEverythingViewModel({ agents: () => [agent], strings: () => strings });
    const view = render(<StopEverythingButton stop={model} />);
    const button = screen.getByRole("button", { name: strings.stopEverything }) as HTMLButtonElement;

    expect(button.title).toBe(strings.stopEverythingTip);
    expect(view.container.querySelector(".fdn-stop-everything")!.getAttribute("lang")).toBe(strings.language);
    expect(view.container.querySelector(".fdn-stop-everything-result")).toBeNull(); // nothing said before the first press

    await act(async () => { fireEvent.click(button); });

    await waitFor(() => expect(view.container.querySelector(".fdn-stop-everything-result")!.textContent).toBe(strings.stopEverythingNothing));
    expect(screen.queryByRole("alertdialog")).toBeNull(); // no confirmation
  });
});
