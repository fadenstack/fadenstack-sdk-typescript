import { describe, expect, it, vi } from "vitest";

import { FadenstackApiError, FadenstackSignInRequiredError, HOST_TOOL_DISPATCH_FEATURE, ErrorCodes, isAgentDisabled, type AgentPrincipal, type HostToolDecision } from "@fadenstack/client";
import {
  ApprovalDecision, EntryTypes, FadenstackAgent, TURNED_OFF_TEXT, defineTool,
  type ApprovalHandler, type ApprovalRequest, type ChatSession, type StopAllResult,
} from "@fadenstack/agents";
import { lastToolResults, type FakeModel } from "@fadenstack/testing";

import { PAGE_CONTRACT, setup, until } from "./helpers.js";
import { OFFERED, Script, fixture, decisions } from "./grantHelpers.js";

// "Stop everything" (release plan 8.11) and the agent off-switch (8.3): the emergency stop ends every running turn and every grant the
// agent holds, also offline; a refused sign-in ends a turn at once; and an agent the organisation turned off makes no request but its
// events and manifest, whatever route finds it out. The .NET SDK's StopEverythingTests.

/** A card that waits for `delete_page`, and allows the rest for the chat. */
class Cards implements ApprovalHandler {
  readonly asked: ApprovalRequest[] = [];
  waiting = 0;

  request(request: ApprovalRequest, signal: AbortSignal): Promise<ReturnType<typeof ApprovalDecision.approve>> {
    this.asked.push(request);
    if (request.toolName !== "delete_page") return Promise.resolve(ApprovalDecision.approveForSession());
    this.waiting++;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  }
}

/** Runs a turn; true when it ended as stopped. */
async function run(session: ChatSession, text: string): Promise<boolean> {
  try {
    for await (const _ of session.stream(text)) { /* the events are not the point */ }
    return false;
  } catch (error) {
    return error instanceof Error && error.name === "AbortError";
  }
}

async function twoBusyChats() {
  const cards = new Cards();
  const s = await fixture({ configure: (b) => b.useApprovals(cards) });
  s.script
    .calls({ id: "c1", name: "write_page", arguments: { page: 1, text: "a" } }).says("One.")
    .calls({ id: "c2", name: "write_page", arguments: { page: 2, text: "b" } }).says("Two.")
    .calls({ id: "d1", name: "delete_page", arguments: { page: 1 } })
    .calls({ id: "d2", name: "delete_page", arguments: { page: 2 } });
  await s.agent.start();
  await s.agent.approvalStore.add("docs", { tool: "read_page", toolClass: "read", source: "host", approvedAt: new Date().toISOString() });
  const a = await s.agent.startSession("ask");
  await a.send("one");
  const b = await s.agent.startSession("ask");
  await b.send("two");
  const turnA = run(a, "three");
  await until(() => cards.waiting === 1);
  const turnB = run(b, "four");
  await until(() => cards.waiting === 2);
  return { ...s, cards, a, b, turnA, turnB };
}

describe("stop everything", () => {
  it("stops both turns, answers their cards no and ends every grant, but keeps what was allowed always", async () => {
    const s = await twoBusyChats();
    await s.agent.grants.grantForTime("read_page", 30 * 60_000);
    await s.agent.grants.grantForTime("write_page", 30 * 60_000);
    s.grants.hold("time", { tools: ["stamp"] }); // another app's, which this copy does not know yet
    expect([...s.a.approvedForSession]).toEqual(["write_page"]);
    expect(s.a.isRunning && s.b.isRunning).toBe(true);

    const result = await s.agent.stopAll();

    expect(result).toEqual({ turnsStopped: 2, grantsEnded: 5, chatApprovalsEnded: 2, grantsNotTold: 0 });
    expect(await s.turnA && await s.turnB).toBe(true);
    expect(s.a.approvedForSession.size + s.b.approvedForSession.size).toBe(0);
    expect(s.agent.grants.live).toEqual([]);
    for (const id of ["g-1", "g-2", "g-3"]) expect(s.grants.status(id)).toBe("revoked");
    expect((await s.agent.listApprovals()).map((a) => a.tool)).toEqual(["read_page"]); // "always" stays
    for (const chat of [s.a, s.b]) {
      expect(chat.transcript.filter((e) => e.type === EntryTypes.turnEnd).at(-1)!.data["status"]).toBe("cancelled");
      const answer = decisions(chat).at(-1)!;
      expect(answer["approved"]).toBe(false); // the card was answered no
      expect(answer["reason"]).toBe("Stopped.");
    }
    expect(s.a.isRunning || s.b.isRunning).toBe(false);
  });

  it("ends the grants here and counts those the server could not be told about, after one more try", async () => {
    const s = await fixture();
    await s.agent.start();
    await s.agent.grants.grantForTime("read_page", 30 * 60_000);
    await s.agent.grants.grantForTime("write_page", 30 * 60_000);
    s.grants.revokeOffline = true; // the server cannot be reached when a grant is ended

    const result = await s.agent.stopAll();

    expect(result).toEqual({ turnsStopped: 0, grantsEnded: 2, chatApprovalsEnded: 0, grantsNotTold: 2 });
    expect(s.gateway.requests.filter((r) => r.method === "DELETE")).toHaveLength(4); // each tried twice
    expect(s.agent.grants.live).toEqual([]); // ended here: none covers a call now
    expect(s.agent.grants.endedHere("g-1") && s.agent.grants.endedHere("g-2")).toBe(true);
    expect(s.grants.status("g-1")).toBe("active"); // the server was not told, and a check does not bring it back
    const verdict = await s.agent.grants.check("g-1", { callId: "x", toolName: "read_page", toolClass: "read", arguments: {}, requiredByRule: false,
      conversationId: "any", turnId: "t", inBypass: false, gateway: false }, new AbortController().signal);
    expect(verdict.covered).toBe(false);
  });

  it("says nothing ran when nothing did", async () => {
    const s = await fixture();
    await s.agent.start();
    await s.agent.startSession();
    const result = await s.agent.stopAll();
    expect(result).toEqual({ turnsStopped: 0, grantsEnded: 0, chatApprovalsEnded: 0, grantsNotTold: 0 });
  });

  it("stops several agents and adds the counts", async () => {
    const first = await twoBusyChats();
    const second = await twoBusyChats();

    const result: StopAllResult = await FadenstackAgent.stopAll([first.agent, second.agent]);

    expect(result.turnsStopped).toBe(4);
    expect(result.chatApprovalsEnded).toBe(4);
    expect((await Promise.all([first.turnA, first.turnB, second.turnA, second.turnB])).every(Boolean)).toBe(true);
  });
});

// -- a refused refresh ends the turn ------------------------------------------------------------

const principal: AgentPrincipal = { tenantId: "tenant", userId: "user", agentId: "agent", deviceId: "device" };
const prepared: HostToolDecision = { decision: "run", toolClass: "read", effectiveToolMode: "auto", requiredByRule: false,
  message: "ok", profileStamp: "a".repeat(64), argumentsStamp: "b".repeat(64), decisionStamp: "c".repeat(64), principal };

describe("a refresh the server refused, in the middle of a turn", () => {
  it("ends the turn at once, and no tool of the turn runs after", async () => {
    let s!: Awaited<ReturnType<typeof setup>>;
    const model: FakeModel = (request) => {
      if (lastToolResults(request).size) return { text: "Never." };
      s.gateway.revoke(); // the sign-in ends right after the model answered: the next refresh is refused
      s.gateway.expireAccessTokens();
      return { toolCalls: [{ id: "a", name: "read_page", arguments: { page: 1 } }, { id: "b", name: "read_page", arguments: { page: 2 } }] };
    };
    s = await setup({ model }, undefined, (b) => b.requireHostToolPolicyChecks());
    const resource = s.client.agent!;
    const original = resource.getProfile.bind(resource);
    vi.spyOn(resource, "getProfile").mockImplementation(async (signal) => {
      const p = await original(signal);
      return { ...p, principal, features: [...p.features, HOST_TOOL_DISPATCH_FEATURE] };
    });
    const check = vi.spyOn(resource, "checkHostTool").mockResolvedValue(prepared);
    const session = await s.agent.startSession("auto");
    const read = vi.spyOn(s.pages.read, "invoke");

    await expect(session.send("Read.")).rejects.toBeInstanceOf(FadenstackSignInRequiredError);

    expect(read).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
    expect(s.gateway.modelCalls).toHaveLength(1); // no second model round
    expect(session.transcript.filter((e) => e.type === EntryTypes.turnEnd).at(-1)!.data["status"]).toBe("error");
  });

  it("does not let the next call of the turn run after a tool's own server call was refused", async () => {
    const ran: string[] = [];
    let s!: Awaited<ReturnType<typeof setup>>;
    const askServer = defineTool<{ page: number }>({
      name: "ask_server", toolClass: "read", parameters: { type: "object", properties: { page: { type: "integer" } }, required: ["page"] },
      run: async () => { ran.push("ask_server"); await s.client.agent!.listTools(); return "page"; },
    });
    const model: FakeModel = (request) => {
      if (lastToolResults(request).size) return { text: "Never." };
      s.gateway.revoke();
      s.gateway.expireAccessTokens();
      return { toolCalls: [{ id: "a", name: "ask_server", arguments: { page: 1 } }, { id: "b", name: "write_page", arguments: { page: 1, text: "x" } }] };
    };
    s = await setup({ model, agents: [{ slug: "docs", contract: [...PAGE_CONTRACT, { name: "ask_server", risk: "read" }] }] }, undefined, (b) => b.addTools(askServer));
    const write = vi.spyOn(s.pages.write, "invoke");
    const session = await s.agent.startSession("auto");

    await expect(session.send("Go.")).rejects.toBeInstanceOf(FadenstackSignInRequiredError);

    expect(ran).toEqual(["ask_server"]);
    expect(write).not.toHaveBeenCalled(); // the second call did not run after the refusal
    expect(s.gateway.modelCalls).toHaveLength(1);
  });
});

// -- the off-switch -----------------------------------------------------------------------------

const ONLY_THESE = ["/v1/agents/docs/profile", "/v1/agents/docs/events", "/v1/agents/docs/manifest"];

describe("the off-switch", () => {
  it("an agent that starts off makes no request but its profile, events and manifest, and refuses a turn with the sentence", async () => {
    const s = await fixture();
    s.gateway.turnOff();
    const changes: boolean[] = [];
    s.agent.onTurnedOffChange(() => changes.push(s.agent.turnedOff));
    const before = s.gateway.requests.length;

    await s.agent.start();
    const session = await s.agent.startSession("auto");
    const result = await session.send("Hello.");
    await session.close();

    expect(s.agent.turnedOff).toBe(true);
    expect(s.agent.profile.enabled).toBe(false);
    expect(changes).toEqual([true]);
    expect(result.outcome).toBe("agent_disabled");
    expect(result.notices[0]).toMatchObject({ outcome: "agent_disabled", message: "Your organisation turned this agent off." });
    expect(TURNED_OFF_TEXT).toBe("Your organisation turned this agent off.");
    expect(s.gateway.modelCalls).toHaveLength(0);
    expect(s.gateway.refusedWhileOff()).toEqual([]);
    expect(s.gateway.reported.length).toBeGreaterThan(0); // the events still go
    for (const r of s.gateway.requests.slice(before)) if (r.path.startsWith("/v1/agents/")) expect(ONLY_THESE).toContain(r.path);
  });

  it("the switch in the middle of a turn ends it with the sentence, ends the grants and asks nothing more", async () => {
    const s = await fixture();
    s.script.reply({ toolCalls: [{ id: "a", name: "read_page", arguments: { page: 1 } }] });
    await s.agent.start();
    await s.agent.grants.grantForTime("read_page", 30 * 60_000);
    const session = await s.agent.startSession("auto");
    // The administrator turns it off while the first answer streams: after the model has answered, before the second round.
    const toolRan = vi.spyOn(s.pages.read, "invoke").mockImplementation(() => { s.gateway.turnOff(); return "page"; });

    const result = await session.send("Read.");

    expect(toolRan).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe("agent_disabled");
    expect(result.notices[0]!.message).toBe("Your organisation turned this agent off.");
    expect(s.agent.turnedOff).toBe(true);
    expect(s.gateway.refusedWhileOff(s.gateway.offAt)).toHaveLength(1); // the second round hit the refusal; nothing was asked after it
    expect(s.agent.grants.live).toEqual([]);
    expect(s.grants.status("g-1")).toBe("revoked");
    expect(await s.agent.grants.whyEnded("g-1")).toBe("agent_turned_off");
    expect(session.transcript.filter((e) => e.type === EntryTypes.turnEnd).at(-1)!.data["status"]).toBe("error");
    const modelCalls = s.gateway.modelCalls.length;
    const again = await session.send("Again.");
    expect(again.outcome).toBe("agent_disabled"); // a new turn is refused without a request
    expect(s.gateway.modelCalls).toHaveLength(modelCalls);
  });

  it("a refusal at a tool call's check ends the turn, and the calls after it never run", async () => {
    const s = await setup({ model: new Script().calls({ id: "a", name: "read_page", arguments: { page: 1 } }, { id: "b", name: "read_page", arguments: { page: 2 } }).says("Never.").model },
      undefined, (b) => b.requireHostToolPolicyChecks());
    const resource = s.client.agent!;
    const original = resource.getProfile.bind(resource);
    vi.spyOn(resource, "getProfile").mockImplementation(async (signal) => {
      const p = await original(signal);
      return { ...p, principal, features: [...p.features, HOST_TOOL_DISPATCH_FEATURE] };
    });
    const check = vi.spyOn(resource, "checkHostTool").mockRejectedValue(
      new FadenstackApiError(403, "Your organisation turned this agent off.", { code: ErrorCodes.agentDisabled, type: "permission_error" }));
    const ran = vi.spyOn(s.pages.read, "invoke");
    const session = await s.agent.startSession("auto");

    const result = await session.send("Read.");

    expect(result.outcome).toBe("agent_disabled");
    expect(s.agent.turnedOff).toBe(true);
    expect(ran).not.toHaveBeenCalled();
    expect(check).toHaveBeenCalledTimes(1); // the second call was not checked
    expect(s.gateway.modelCalls).toHaveLength(1);
  });

  it("a grants route that answers agent_disabled turns the agent off, and nothing asks the server again", async () => {
    const s = await fixture();
    await s.agent.start();
    s.gateway.turnOff();
    const before = s.gateway.requests.length;

    const error = await s.agent.grants.refresh().catch((e: unknown) => e);

    expect(isAgentDisabled(error)).toBe(true);
    expect(s.agent.turnedOff).toBe(true);
    const asked = s.gateway.requests.length;
    await expect(s.agent.grants.grantForTime("read_page", 15 * 60_000)).rejects.toSatisfy(isAgentDisabled);
    await expect(s.agent.listServerTools()).rejects.toSatisfy(isAgentDisabled);
    await expect(s.agent.setUserLanguage("de")).rejects.toSatisfy(isAgentDisabled);
    expect(s.gateway.requests.length).toBe(asked); // no retry, no further request
    expect(s.gateway.refusedWhileOff(before)).toHaveLength(1);
  });

  it("the switch ends the running turns of every chat with the sentence, not as stopped", async () => {
    const s = await twoBusyChats();
    await s.agent.grants.grantForTime("read_page", 30 * 60_000);
    s.gateway.turnOff();

    await expect(s.agent.grants.refresh()).rejects.toSatisfy(isAgentDisabled); // a route finds it out

    expect(await s.turnA || await s.turnB).toBe(false); // not stopped: the turns ended with the notice
    for (const chat of [s.a, s.b]) {
      expect(chat.transcript.filter((e) => e.type === EntryTypes.turnEnd).at(-1)!.data).toMatchObject({ status: "error", outcome: "agent_disabled" });
      expect(chat.transcript.filter((e) => e.type === EntryTypes.governanceNotice).at(-1)!.data["outcome"]).toBe("agent_disabled");
    }
    expect(s.grants.status("g-1")).toBe("revoked");
    expect(s.agent.grants.live).toEqual([]);
  });

  it("check again reads the profile only, and turns the agent back on when it says enabled", async () => {
    const s = await fixture();
    s.gateway.turnOff();
    s.script.says("Back.");
    await s.agent.start();
    let changes = 0;
    s.agent.onTurnedOffChange(() => { changes++; });
    const profileReads = () => s.gateway.requests.filter((r) => r.path === "/v1/agents/docs/profile").length;
    const reads = profileReads();

    expect(await s.agent.checkAgain()).toBe(true); // still off
    expect(profileReads()).toBe(reads + 1);
    expect(changes).toBe(0);

    s.gateway.turnOn();
    expect(await s.agent.checkAgain()).toBe(false);

    expect(s.agent.turnedOff).toBe(false);
    expect(changes).toBe(1);
    expect(s.gateway.refusedWhileOff()).toEqual([]);
    expect((await (await s.agent.startSession()).send("Hello.")).outcome).toBe("completed");
  });

  it("an older server with no enabled key is on", async () => {
    const s = await fixture();
    await s.agent.start();
    expect(s.agent.profile.enabled).toBe(true);
    expect(s.agent.turnedOff).toBe(false);
  });
});
