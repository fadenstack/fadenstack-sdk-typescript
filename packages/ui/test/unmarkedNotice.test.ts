import { describe, expect, it } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore } from "@fadenstack/agents";
import {
  AgentChatViewModel, ApprovalBroker, MemoryPreferenceStore, NoticePart, UNMARKED_PREFERENCE, builtInStrings, englishStrings,
  immediateScheduler, type AgentChatOptions,
} from "@fadenstack/ui";
import { FakeGateway } from "@fadenstack/testing";

const unmarked = { type: "CUSTOM", name: "faden.unmarked", value: { reason: "allowed-by-administrator" } };

async function chat(events: Record<string, unknown>[], options: AgentChatOptions = {}, start = true) {
  const gateway = new FakeGateway({ agents: [{ slug: "page", name: "Page" }], model: () => ({ text: "Answer.", events }) });
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
  await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const approvals = new ApprovalBroker();
  const agent = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals).build();
  const vm = new AgentChatViewModel(agent, approvals, { scheduler: immediateScheduler, preferences: new MemoryPreferenceStore(), automaticLanguage: "en", ...options });
  if (start) await vm.initialize();
  return vm;
}

const notices = (vm: AgentChatViewModel) => vm.turns.at(-1)!.parts.filter((p): p is NoticePart => p instanceof NoticePart);

describe("the notice for an answer without an AI mark (faden.unmarked)", () => {
  it("is hidden by default", async () => {
    const vm = await chat([unmarked]);
    expect(vm.showUnmarkedNotice).toBe(false);
    await vm.send("Hi");
    expect(notices(vm)).toHaveLength(0);
  });

  it("when turned on, is a real notice in the panel's language, once per answer", async () => {
    const vm = await chat([unmarked, unmarked]);
    await vm.setShowUnmarkedNotice(true);
    await vm.send("Hi");
    expect(notices(vm).map((n) => [n.title, n.message])).toEqual([[englishStrings.unmarkedTitle, englishStrings.unmarkedMessage]]);
    await vm.send("Again");
    expect(notices(vm)).toHaveLength(1); // a new answer gets its own
    await vm.setLanguage("de");
    expect(notices(vm)[0]!.title).toBe(builtInStrings["de"]!.unmarkedTitle);
  });

  it("is kept per user in the preferences, and read back", async () => {
    const preferences = new MemoryPreferenceStore();
    const first = await chat([unmarked], { preferences });
    await first.setShowUnmarkedNotice(true);
    expect(preferences.get(UNMARKED_PREFERENCE)).toBe("1");
    const second = await chat([unmarked], { preferences });
    expect(second.showUnmarkedNotice).toBe(true);
    await second.send("Hi");
    expect(notices(second)).toHaveLength(1);
    await second.setShowUnmarkedNotice(false);
    expect(preferences.get(UNMARKED_PREFERENCE)).toBeUndefined();
    expect((await chat([unmarked], { preferences })).showUnmarkedNotice).toBe(false);
  });

  it("is off from the first paint, and a store that answers at once is read at once", async () => {
    expect((await chat([unmarked], {}, false)).showUnmarkedNotice).toBe(false);
    const preferences = new MemoryPreferenceStore();
    preferences.set(UNMARKED_PREFERENCE, "1");
    expect((await chat([unmarked], { preferences }, false)).showUnmarkedNotice).toBe(true);
  });

  it("reads a store that answers later", async () => {
    const slow = { get: () => Promise.resolve("1"), set: () => undefined };
    const vm = await chat([unmarked], { preferences: slow });
    expect(vm.showUnmarkedNotice).toBe(true);
  });
});

describe("an event the chat does not know", () => {
  it("without a message shows nothing, never its name", async () => {
    const vm = await chat([{ type: "CUSTOM", name: "faden.something_new", value: { a: 1 } }, { type: "CUSTOM", name: "faden.other" }]);
    await vm.send("Hi");
    expect(notices(vm)).toHaveLength(0);
  });

  it("with a message shows it, as before", async () => {
    const vm = await chat([{ type: "CUSTOM", name: "faden.something_new", value: { message: "Heads up." } }]);
    await vm.send("Hi");
    expect(notices(vm).map((n) => [n.title, n.message])).toEqual([["Notice", "Heads up."]]);
  });
});

describe("the unmarked texts", () => {
  it("exist in every language, translated", () => {
    for (const [tag, s] of Object.entries(builtInStrings)) {
      for (const key of ["unmarkedTitle", "unmarkedMessage", "settingsUnmarked"] as const) {
        expect(s[key], `${tag} ${key}`).toBeTruthy();
        if (tag !== "en") expect(s[key], `${tag} ${key}`).not.toBe(englishStrings[key]);
      }
    }
  });
});
