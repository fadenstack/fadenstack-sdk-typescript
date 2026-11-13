// @vitest-environment jsdom
// The approval card of a local MCP tool in both skins: the title on a row of its own, the class and the source line under it (G4).
import { act, cleanup, render } from "@testing-library/react";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore, type AgentTool } from "@fadenstack/agents";
import { AgentChatViewModel, ApprovalBroker, ApprovalPart, germanStrings, immediateScheduler, type AgentChatOptions } from "@fadenstack/ui";
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

function mcpTool(extra: Partial<AgentTool> = {}): AgentTool {
  return {
    name: "allowed_folders", parameters: { type: "object", properties: {} }, toolClass: "unknown", source: "mcp", server: "Files",
    invoke: () => "ok", ...extra,
  };
}

async function pendingCard(tool: AgentTool, options: Partial<AgentChatOptions> = {}) {
  const gateway = new FakeGateway({
    agents: [{ slug: "page" }],
    model: (r) => (lastToolResults(r).size ? { text: "Done." } : { toolCalls: [{ name: tool.name, arguments: {} }] }),
  });
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const approvals = new ApprovalBroker();
  const agent = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals).addTools(tool).build();
  const chat = new AgentChatViewModel(agent, approvals, { ...testServices(), scheduler: immediateScheduler, locale: "en-GB", ...options });
  await chat.initialize();
  const react = render(createElement(ReactPanel, { chat }));
  const vue = mount(VuePanel, { props: { chat }, attachTo: document.body });
  wrappers.push(vue);
  void chat.send("Go.");
  await waitUntil(() => chat.turns[0]?.parts.some((p) => p instanceof ApprovalPart) ?? false);
  await act(async () => {});
  await flushPromises();
  return { chat, roots: [react.container, vue.element as Element], same: () => expect(normalize(vue.element)).toBe(normalize(react.container.firstElementChild!)) };
}

describe("the card of a local MCP tool in both skins", () => {
  it("has the title alone on its row, with the tool's name in code, and the class and the server under it", async () => {
    const { roots, same } = await pendingCard(mcpTool({ readOnlyHint: true }));
    same();
    for (const root of roots) {
      const card = root.querySelector(".fdn-approval")!;
      const head = card.querySelector(".fdn-approval-head")!;
      expect(head.querySelector("strong")!.textContent).toBe("Run allowed_folders?");
      expect(head.querySelector("strong code")!.textContent).toBe("allowed_folders");
      expect(head.querySelector(".fdn-badge")).toBeNull(); // not beside the title
      const row = card.querySelector(".fdn-approval-source")!;
      expect(row.querySelector(".fdn-badge")!.textContent).toBe("Unclassified");
      expect(row.querySelector(".fdn-approval-from")!.textContent).toBe("From Files, an MCP server on this computer");
      expect(row.querySelector(".fdn-approval-from svg")).not.toBeNull();
      expect(card.querySelector(".fdn-approval-reason")!.textContent).toBe("Your organisation has not checked this tool. The server says it only reads.");
    }
  });

  it("shows no source line for another tool, and the texts in the language of the panel", async () => {
    const other = await pendingCard(mcpTool({ source: "host", name: "do_it" }));
    other.same();
    for (const root of other.roots) {
      expect(root.querySelector(".fdn-approval-from")).toBeNull();
      expect(root.querySelector(".fdn-approval-reason")!.textContent).toBe("Nobody has said what this tool does.");
    }
    cleanup();
    for (const w of wrappers) w.unmount();
    wrappers = [];
    const german = await pendingCard(mcpTool({ destructiveHint: true }), { strings: germanStrings });
    german.same();
    for (const root of german.roots) {
      expect(root.querySelector(".fdn-approval-from")!.textContent).toBe("Von Files, einem MCP-Server auf diesem Computer");
      expect(root.querySelector(".fdn-approval-reason")!.textContent)
        .toBe("Ihre Organisation hat dieses Tool nicht geprüft. Der Server gibt an, dass es löschen oder überschreiben kann.");
    }
  });
});
