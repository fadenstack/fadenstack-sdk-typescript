// @vitest-environment jsdom
// The card of a call the gateway holds, in the view model and in both skins: its arguments, and the note when they were cut.
import { act, cleanup, render } from "@testing-library/react";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore } from "@fadenstack/agents";
import {
  AgentChatViewModel, ApprovalBroker, ApprovalPart, germanStrings, immediateScheduler, type AgentChatOptions,
} from "@fadenstack/ui";
import { ChatPanel as ReactPanel } from "@fadenstack/ui-react";
import { ChatPanel as VuePanel } from "@fadenstack/ui-vue";
import { FakeGateway, lastToolResults } from "@fadenstack/testing";

import { normalize, testServices, waitUntil } from "./helpers.js";

let wrappers: VueWrapper[] = [];
afterEach(() => {
  cleanup();
  for (const w of wrappers) w.unmount();
  wrappers = [];
});

async function held(argumentsEvent: { arguments?: string; argumentsTruncated?: true }, options: Partial<AgentChatOptions> = {}) {
  const gateway = new FakeGateway({
    agents: [{ slug: "page" }],
    model: (r) => (lastToolResults(r).size ? { text: "Done." }
      : { text: "Commenting.", gatewayTool: { name: "mcp.github.comment", arguments: { title: "x" }, approval: { rule: true, toolClass: "write", argumentsEvent } } }),
  });
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const approvals = new ApprovalBroker();
  const agent = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals).build();
  const chat = new AgentChatViewModel(agent, approvals, { ...testServices(), scheduler: immediateScheduler, locale: "en-GB", ...options });
  await chat.initialize();
  const react = render(createElement(ReactPanel, { chat }));
  const vue = mount(VuePanel, { props: { chat }, attachTo: document.body });
  wrappers.push(vue);
  void chat.send("Go.");
  await waitUntil(() => chat.turns[0]?.parts.some((p) => p instanceof ApprovalPart) ?? false);
  await act(async () => {});
  await flushPromises();
  const part = chat.turns[0]!.parts.find((p): p is ApprovalPart => p instanceof ApprovalPart)!;
  return { part, roots: [react.container, vue.element as Element], same: () => expect(normalize(vue.element)).toBe(normalize(react.container.firstElementChild!)) };
}

describe("a held call's card", () => {
  it("shows a complete JSON object's members and no note", async () => {
    const { part, roots, same } = await held({ arguments: '{"title":"x","page":2}' });

    same();
    expect([part.argumentsText, part.argumentsNote, part.hasArgumentsNote]).toEqual(["title: x\npage: 2", "", false]);
    for (const root of roots) {
      expect(root.querySelector(".fdn-approval-args")!.textContent).toBe("title: x\npage: 2");
      expect(root.querySelector(".fdn-approval-args-note")).toBeNull();
    }
  });

  it("shows a cut text alone with the note under it, in both skins", async () => {
    const { part, roots, same } = await held({ arguments: '{"title":"x', argumentsTruncated: true });

    same();
    expect([part.argumentsText, part.argumentsNote]).toEqual(['{"title":"x', "The arguments are shortened."]);
    for (const root of roots) {
      const args = root.querySelector(".fdn-approval-args")!;
      expect(args.textContent).toBe('{"title":"x');
      expect(args.nextElementSibling!.className).toContain("fdn-approval-args-note");
      expect(args.nextElementSibling!.textContent).toBe("The arguments are shortened.");
    }
  });

  it("never shows more than the card's usual preview", async () => {
    const { part } = await held({ arguments: "x".repeat(8000), argumentsTruncated: true }, { previewLength: 200 });

    expect(part.argumentsText.length).toBeLessThan(400);
    expect(part.argumentsText.startsWith("x".repeat(200))).toBe(true);
  });

  it("shows no arguments and no note from an older gateway", async () => {
    const { part, roots } = await held({});

    expect([part.argumentsText, part.argumentsNote]).toEqual(["", ""]);
    for (const root of roots) expect(root.querySelector(".fdn-approval-args")).toBeNull();
  });

  it("says the note in German", async () => {
    const { part } = await held({ arguments: "kein JSON" }, { strings: germanStrings });

    expect(part.argumentsNote).toBe("Die Argumente sind gekürzt.");
  });
});
