import { describe, expect, it } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore } from "@fadenstack/agents";
import { AgentChatViewModel, ApprovalBroker, MemoryClipboard, MemoryPreferenceStore, immediateScheduler, type FileToSave } from "@fadenstack/ui";
import { FakeGateway } from "@fadenstack/testing";
import { testServices } from "./services.js";

// sdk/52 P4 (owner, 13 Nov): @fadenstack/ui has no browser default. The clipboard, the link opener, the download and the
// preferences store are the host's, and a host that forgets one gets a type error, not a silent loss of the user's
// choices. `npm run typecheck` checks the @ts-expect-error lines below: each one fails the check as soon as its option
// is optional again.

/** Never run: the compiler's view of a host that forgets one of the four. */
export function forgotten(agent: FadenstackAgent, approvals: ApprovalBroker): void {
  const { clipboard: _clipboard, ...noClipboard } = testServices();
  // @ts-expect-error -- the clipboard is the host's
  new AgentChatViewModel(agent, approvals, noClipboard);
  const { openLink: _openLink, ...noOpenLink } = testServices();
  // @ts-expect-error -- the link opener is the host's
  new AgentChatViewModel(agent, approvals, noOpenLink);
  const { saveFile: _saveFile, ...noSaveFile } = testServices();
  // @ts-expect-error -- the download is the host's
  new AgentChatViewModel(agent, approvals, noSaveFile);
  const { preferences: _preferences, ...noPreferences } = testServices();
  // @ts-expect-error -- the preferences store is the host's
  new AgentChatViewModel(agent, approvals, noPreferences);
  // @ts-expect-error -- no options at all
  new AgentChatViewModel(agent, approvals);
}

describe("the host's services", () => {
  it("are the ones the panel uses: its links and the user's choices go through the host", async () => {
    const opened: string[] = [];
    const saved: FileToSave[] = [];
    const preferences = new MemoryPreferenceStore();
    const gateway = new FakeGateway({ agents: [{ slug: "page", name: "Page assistant" }] });
    const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
    await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
    const approvals = new ApprovalBroker();
    const agent = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals).build();
    const chat = new AgentChatViewModel(agent, approvals, {
      clipboard: new MemoryClipboard(), openLink: (url) => void opened.push(url), saveFile: (file) => void saved.push(file), preferences,
      scheduler: immediateScheduler, automaticLanguage: "en",
    });
    await chat.initialize();
    chat.openLink("https://fadenstack.com/");
    expect(opened).toEqual(["https://fadenstack.com/"]);
    await chat.setLanguage("de");
    expect(preferences.get("language")).toBe("de");
    expect(saved).toEqual([]);
    expect(typeof forgotten).toBe("function");
  });
});
