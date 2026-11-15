import { describe, expect, it } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore } from "@fadenstack/agents";
import { AgentChatViewModel, ApprovalBroker, MemoryPreferenceStore, MemoryPromptStore, UNMARKED_PREFERENCE, immediateScheduler, type FollowsPerson, type PersonSource, type PreferenceStore, type PromptStore } from "@fadenstack/ui";
import { FakeGateway } from "@fadenstack/testing";
import { testServices } from "./services.js";

/** A store that keeps one value per person, as `browserPreferences()` does, and knows no one until told. */
class PerPerson implements PreferenceStore, FollowsPerson {
  readonly values = new Map<string, string>();
  source: PersonSource | undefined;
  readonly reads: (string | undefined)[] = [];
  followPerson(source: PersonSource): void {
    this.source = source;
  }
  get(name: string): string | undefined {
    const who = this.source?.();
    this.reads.push(who ? who.principal?.userId : "unknown");
    return who ? this.values.get(`${who.principal?.userId}/${name}`) : undefined;
  }
  set(name: string, value: string | undefined): void {
    const who = this.source?.();
    if (who && value !== undefined) this.values.set(`${who.principal?.userId}/${name}`, value);
  }
}

describe("a store kept per person", () => {
  it("is told the agent's principal, is not read before the agent has started, and is read for the person the profile names", async () => {
    const gateway = new FakeGateway({ users: [{ email: "anna@example.com", password: "secret" }], principal: true, agents: [{ slug: "page", name: "Page" }], model: () => ({ text: "Hi." }) });
    const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
    await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "anna@example.com", password: "secret", fetch: gateway.fetch }));
    const approvals = new ApprovalBroker();
    const agent = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals).build();
    const preferences = new PerPerson();
    preferences.values.set("user-1/" + UNMARKED_PREFERENCE, "1");
    preferences.values.set("someone-else/" + UNMARKED_PREFERENCE, "0");
    const followed: PersonSource[] = [];
    const prompts: PromptStore & FollowsPerson = Object.assign(new MemoryPromptStore(), { followPerson: (s: PersonSource) => void followed.push(s) });
    const vm = new AgentChatViewModel(agent, approvals, { ...testServices(), preferences, prompts, scheduler: immediateScheduler, automaticLanguage: "en" });

    expect(preferences.reads).toEqual([]); // whose they are is not known before the agent has started
    expect(followed).toHaveLength(1);
    expect(followed[0]!()).toBeUndefined();
    expect(vm.showUnmarkedNotice).toBe(false);

    await vm.initialize();

    expect(followed[0]!()).toEqual({ principal: expect.objectContaining({ userId: "user-1" }) });
    expect(preferences.reads.every((r) => r === "user-1")).toBe(true);
    expect(vm.showUnmarkedNotice).toBe(true);
  });

  it("is read as before by a store that does not follow", async () => {
    const preferences = new MemoryPreferenceStore();
    preferences.set(UNMARKED_PREFERENCE, "1");
    const gateway = new FakeGateway({ agents: [{ slug: "page", name: "Page" }], model: () => ({ text: "Hi." }) });
    const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
    await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
    const approvals = new ApprovalBroker();
    const agent = FadenstackAgent.createBuilder().useClient(client).useSessionStore(new MemorySessionStore()).useApprovals(approvals).build();
    const vm = new AgentChatViewModel(agent, approvals, { ...testServices(), preferences, scheduler: immediateScheduler, automaticLanguage: "en" });
    expect(vm.showUnmarkedNotice).toBe(true); // from the first paint
  });
});
