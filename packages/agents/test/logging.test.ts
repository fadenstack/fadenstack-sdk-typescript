import { describe, expect, it } from "vitest";

import { AgentTokenProvider, FadenstackClient, MemoryTokenStore, type FadenstackLogger, type LogEvent } from "@fadenstack/client";
import { AgentLog, ApprovalDecision, FadenstackAgent } from "@fadenstack/agents";
import { FakeGateway, lastToolResults, type FakeModel } from "@fadenstack/testing";
import { setup } from "./helpers.js";

// Content-free log events with the .NET SDK's ids, names and fields (LoggingTests): a logger the host plugs in.

const PROMPT = "SENTINEL-PROMPT", ATTACHMENT = "SENTINEL-ATTACHMENT", ANSWER = "SENTINEL-ANSWER", REASONING = "SENTINEL-REASONING",
  ARGUMENTS = "SENTINEL-ARGUMENTS", RESULT = "SENTINEL-RESULT", NOTICE = "SENTINEL-NOTICE";

class Capture implements FadenstackLogger {
  readonly events: LogEvent[] = [];
  log(event: LogEvent): void { this.events.push(event); }
  ofId(id: number) { return this.events.filter((e) => e.eventId === id); }
  messages(id: number) { return this.ofId(id).map((e) => e.message); }
  get text() { return JSON.stringify(this.events); }
}

const model: FakeModel = (request) => lastToolResults(request).size ? { text: ANSWER, reasoning: REASONING }
  : {
    reasoning: REASONING,
    events: [{ type: "CUSTOM", name: "faden.governance", value: { outcome: "observe", stage: "output", category: "pii", message: NOTICE, decision_id: "d-1" } }],
    toolCalls: [{ id: "call-1", name: "read_page", arguments: { page: 7 } }, { id: "call-2", name: "write_page", arguments: { page: 8, text: ARGUMENTS } }],
  };

describe("the agent's log", () => {
  it("a full turn logs names, ids, counts and outcomes, and no content", async () => {
    const log = new Capture();
    const s = await setup({ model }, () => ApprovalDecision.approve(), (b) => b.useLogging(log));
    try {
      s.pages.pages.set(7, RESULT);
      const session = await s.agent.startSession();
      const result = await session.send(PROMPT, { attachments: [{ title: "Selection", content: ATTACHMENT }] });
      await s.agent.flush();

      expect(log.messages(2000)).toEqual(["Agent docs loaded: version 1, edition community, 1 features, user partition false"]);
      expect(log.messages(2001)).toEqual(["Agent docs tools settled: 3 host, 0 from sources, 0 dropped by the contract"]);
      expect(log.messages(2010)).toEqual([`Turn ${result.turnId} of conversation ${session.id} started in tool mode ask with 1 attachments`]);
      expect(log.messages(2011)[0]).toMatch(new RegExp(`^Turn ${result.turnId} of conversation ${session.id} ended ok \\(completed\\) after 2 rounds in \\d+ ms, tool mode ask$`));
      expect(log.messages(2020).map((m) => m.replace(/in \d+ ms/, "in N ms"))).toEqual([
        "Tool read_page (read, host) ended ok in N ms, approval none", "Tool write_page (write, host) ended ok in N ms, approval once"]);
      expect(log.messages(2021)[0]).toMatch(/^Approval for write_page \(write\): once, asked true, waited \d+ ms$/);
      expect(log.messages(2030)).toEqual(["Governance notice observe at stage output, category pii, code (null), decision d-1"]);
      expect(log.messages(2012)).toHaveLength(2);
      // the client logs its requests, under its own category and ids
      expect(log.messages(1000).filter((m) => m.startsWith("POST /v1/agents/docs/chat/completions answered 200"))).toHaveLength(2);
      expect(log.ofId(1000).every((e) => e.category === "Fadenstack.Client" && e.eventName === "Request")).toBe(true);
      expect(log.ofId(2011)[0]).toMatchObject({ category: "Fadenstack.Agents", eventName: "TurnEnded", level: "information",
        scope: { ConversationId: session.id, TurnId: result.turnId },
        fields: { ConversationId: session.id, TurnId: result.turnId, ToolMode: "ask", Rounds: 2, Status: "ok", Outcome: "completed" } });
      // and not a word of what was said, done or read
      for (const sentinel of [PROMPT, ATTACHMENT, ANSWER, REASONING, ARGUMENTS, RESULT, NOTICE, "Bearer", "access.", "refresh."]) expect(log.text).not.toContain(sentinel);
      // the content did reach the gateway: the log is the only thing that leaves it out
      expect(JSON.stringify(s.gateway.modelCalls[0]!.messages)).toContain(PROMPT);
    } finally { await s.agent.dispose(); }
  });

  it("a declined tool is an outcome in the log too, and a made-up tool is logged as unknown", async () => {
    const log = new Capture();
    const s = await setup({ model: (r) => lastToolResults(r).size ? { text: "No." } : { toolCalls: [{ id: "c1", name: "write_page", arguments: { page: 1, text: "x" } }, { id: "c2", name: "SENTINEL-MADE-UP" }] } },
      () => ApprovalDecision.deny(`no ${NOTICE}`), (b) => b.useLogging(log));
    try {
      await (await s.agent.startSession()).send("go");
      expect(log.messages(2020).map((m) => m.replace(/in \d+ ms/, "in N ms"))).toEqual([
        "Tool write_page (write, host) ended denied in N ms, approval none", // the decline is the approval line's word
        "Tool (unknown) (unknown, host) ended error in N ms, approval none"]);
      expect(log.messages(2021)[0]).toMatch(/^Approval for write_page \(write\): declined, asked true/);
      expect(log.messages(2011)[0]).toContain("(tool_denied)");
      expect(log.text).not.toContain("SENTINEL");
    } finally { await s.agent.dispose(); }
  });

  it("logs the tools the contract dropped by name, and the profile's settled tools", async () => {
    const log = new Capture();
    const s = await setup({ agents: [{ slug: "docs", contract: [{ name: "read_page", risk: "read" }] }] }, undefined, (b) => b.useLogging(log));
    try {
      await s.agent.start();
      expect(log.messages(2002).sort()).toEqual(["Host tool delete_page is not in the agent's contract and was dropped", "Host tool write_page is not in the agent's contract and was dropped"]);
      expect(log.messages(2001)).toEqual(["Agent docs tools settled: 1 host, 0 from sources, 2 dropped by the contract"]);
      expect(log.ofId(2002)[0]!.level).toBe("warning");
    } finally { await s.agent.dispose(); }
  });

  it("a logger that throws never fails a turn, and no logger logs nowhere", async () => {
    const s = await setup({ model: () => ({ text: "Fine." }) }, undefined, (b) => b.useLogging({ log: () => { throw new Error("broken sink"); } }));
    try {
      expect((await (await s.agent.startSession()).send("hi")).text).toBe("Fine.");
    } finally { await s.agent.dispose(); }
    const quiet = await setup({ model: () => ({ text: "Fine." }) });
    try {
      expect((await (await quiet.agent.startSession()).send("hi")).text).toBe("Fine.");
    } finally { await quiet.agent.dispose(); }
  });

  it("uses a logger the client already has, and gives its own to a client without one", async () => {
    const mine = new Capture(), clients = new Capture();
    const gateway = new FakeGateway({ agents: [{ slug: "docs" }], model: () => ({ text: "Hi." }) });
    const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "docs", fetch: gateway.fetch, logger: clients });
    await tokens.signIn(await (await import("@fadenstack/client")).loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
    const agent = FadenstackAgent.createBuilder().useClient(client).useLogging(mine).build();
    await (await agent.startSession()).send("hi");
    expect(clients.ofId(1000).length).toBeGreaterThan(0);
    expect(mine.ofId(1000)).toHaveLength(0);
    expect(mine.ofId(2011)).toHaveLength(1);
    await agent.dispose();
  });

  it("refuses a logger without a log method", () => {
    expect(() => FadenstackAgent.createBuilder().useLogging({} as FadenstackLogger)).toThrow(TypeError);
  });

  it("every agent event has its id, name and level from the .NET SDK", () => {
    expect(Object.values(AgentLog).map((d) => [d.eventId, d.eventName, d.level])).toEqual([
      [2000, "ProfileLoaded", "information"], [2001, "ToolsSettled", "information"], [2002, "ToolDropped", "warning"], [2003, "BypassMode", "warning"],
      [2009, "ProfileRereadFailed", "warning"], [2010, "TurnStarted", "information"], [2011, "TurnEnded", "information"],
      [2012, "ModelRequest", "debug"], [2013, "ToolsRefreshed", "information"], [2014, "ToolsRefreshFailed", "warning"],
      [2016, "ToolNameReserved", "warning"], [2017, "ToolNameTaken", "warning"],
      [2020, "ToolCall", "information"], [2021, "Approval", "information"], [2030, "Notice", "information"]]);
  });
});

describe("the sign-in's log", () => {
  it("signing in again, signing out and a failed revoke are logged by name, without a token or the person", async () => {
    const log = new Capture();
    let now = 1_000_000;
    const gateway = new FakeGateway({ agents: [{ slug: "docs" }], now: () => now });
    const store = new MemoryTokenStore();
    const provider = new AgentTokenProvider({ apiUrl: gateway.serverUrl, agent: "docs", store, fetch: gateway.fetch, now: () => now, logger: log });
    const { loginWithPassword } = await import("@fadenstack/client");
    await provider.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
    now += 700_000;
    await provider.getAccessToken(); // renewed
    await provider.signOut();
    const down = new AgentTokenProvider({ apiUrl: gateway.serverUrl, agent: "docs", store, fetch: async () => { throw new TypeError("refused to 10.0.0.1"); }, logger: log });
    await store.save(AgentTokenProvider.storeKey(gateway.serverUrl, "docs"), { accessToken: "a", accessExpiresAt: 0, refreshToken: "refresh-SECRET", refreshExpiresAt: now + 1e9, deviceId: "d", agentId: "i", agent: "docs" });
    await down.signOut();
    expect(log.messages(1010)).toEqual(["The sign-in to agent docs was renewed"]);
    expect(log.messages(1012)).toEqual(["Signed out of agent docs on this device (revoked at the server: true)", "Signed out of agent docs on this device (revoked at the server: false)"]);
    expect(log.messages(1013)).toEqual(["The sign-in to agent docs could not be revoked at the server (TypeError); it is deleted here"]);
    expect(log.text).not.toMatch(/SECRET|access\.|refresh\.|user@example|10\.0\.0\.1/);
  });
});
