// @vitest-environment jsdom
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, describe, expect, it } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore } from "@fadenstack/agents";
import { AgentChatViewModel, ApprovalBroker, StopEverythingViewModel, builtInStrings, immediateScheduler } from "@fadenstack/ui";
import { ChatPanel, StopEverythingButton } from "@fadenstack/ui-vue";
import { FakeGateway } from "@fadenstack/testing";

import { testServices, waitUntil } from "./helpers.js";

// The same checks as @fadenstack/ui-react's stopEverything.test.tsx, on the Vue skin (parity), over the real view models.

const wrappers: VueWrapper[] = [];
afterEach(() => {
  for (const w of wrappers.splice(0)) w.unmount();
});

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
    await chat.initialize();
    await chat.setLanguage(language);
    const wrapper = mount(ChatPanel, { props: { chat }, attachTo: document.body });
    wrappers.push(wrapper);

    expect(wrapper.find(".fdn-agent-off").text()).toContain(strings.agentTurnedOff);
    expect(wrapper.find(".fdn-agent-off").attributes("role")).toBe("status");
    const check = wrapper.find<HTMLButtonElement>(`button[aria-label="${strings.agentTurnedOffCheckAgain}"]`);
    expect(check.text()).toBe(strings.agentTurnedOffCheckAgain);
    expect(wrapper.find<HTMLTextAreaElement>("textarea").element.disabled).toBe(true);
    expect(wrapper.find(".fdn-grants-off").text()).toBe(strings.grantsEndedByOff);

    gateway.turnOn();
    await check.trigger("click");
    await waitUntil(() => !chat.isAgentOff);
    await flushPromises();
    expect(wrapper.find(".fdn-agent-off").exists()).toBe(false);
    expect(wrapper.find<HTMLTextAreaElement>("textarea").element.disabled).toBe(false);
    chat.dispose();
  });

  it("the stop button has its name and tooltip, stops with no confirmation and says what it did", async () => {
    const { agent } = await agentOn(false);
    await agent.start();
    const model = new StopEverythingViewModel({ agents: () => [agent], strings: () => strings });
    const wrapper = mount(StopEverythingButton, { props: { stop: model }, attachTo: document.body });
    wrappers.push(wrapper);
    const button = wrapper.find<HTMLButtonElement>(`button[aria-label="${strings.stopEverything}"]`);

    expect(button.attributes("title")).toBe(strings.stopEverythingTip);
    expect(wrapper.find(".fdn-stop-everything").attributes("lang")).toBe(strings.language);
    expect(wrapper.find(".fdn-stop-everything-result").exists()).toBe(false); // nothing said before the first press

    await button.trigger("click");
    await waitUntil(() => !model.isBusy && model.result !== undefined);
    await flushPromises();

    expect(wrapper.find(".fdn-stop-everything-result").text()).toBe(strings.stopEverythingNothing);
    expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false); // no confirmation
  });
});
