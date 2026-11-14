import { afterEach, describe, expect, it, vi } from "vitest";

import { BYPASS_ENDED_NOTE, BypassSignInError, denyAllApprovals, type GrantAnswer, type GrantOffer } from "@fadenstack/agents";
import { Card, OFFERED, WITHOUT_BYPASS, decisions, fixture, grantPosts, ruleMark } from "./grantHelpers.js";
import { setup } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Bypass held by the server (sdk/09 §3.12, sdk/40 A3). Port of the .NET BypassTests. */
describe("the server's Bypass", () => {
  it("is reachable only where the server offers it", async () => {
    const s = await fixture();
    await s.agent.start();
    expect([s.agent.ceiling, s.agent.bypassOffered]).toEqual(["bypass", true]);

    const older = await fixture({ approvals: WITHOUT_BYPASS });
    await older.agent.start();
    expect([older.agent.ceiling, older.agent.bypassOffered]).toEqual(["auto", false]);

    const capped = await fixture({ maxLevel: "auto" });
    await capped.agent.start();
    expect(capped.agent.ceiling).toBe("auto");
  });

  it("is not offered to a server that does not describe the second sign-in in full, and never throws on what it sends", async () => {
    for (const bypass of [
      { allowed: true, longest_minutes: 60 },
      { allowed: true, longest_minutes: 60, step_up: { required: true, max_age: 300, start: "/elsewhere" } },
      { allowed: "yes", longest_minutes: 60, step_up: { required: true, max_age: 300, start: "/api/agent-tokens/step-ups" } },
      { allowed: true, longest_minutes: -5, step_up: { required: true, max_age: 300, start: "/api/agent-tokens/step-ups" } },
      "later",
    ]) {
      const s = await fixture({ approvals: { ...WITHOUT_BYPASS, bypass } });
      await s.agent.start();
      expect(s.agent.bypassOffered, JSON.stringify(bypass)).toBe(false);
      expect(s.agent.ceiling).toBe("auto");
      expect(await (await s.agent.startSession("ask")).startBypass()).toBeNull();
    }
  });

  it("is a chat set to bypass without its grant: auto", async () => {
    const s = await fixture();
    const session = await s.agent.startSession("bypass");
    expect([session.toolMode, session.effectiveToolMode]).toEqual(["bypass", "auto"]);
    expect(session.bypass).toBeUndefined();
  });

  it("asks first and holds only once the server made its grant", async () => {
    const declining = new Card(false);
    const s = await fixture({ card: declining });
    const session = await s.agent.startSession("ask");

    expect(await session.startBypass()).toBeNull();
    const offer = declining.offers[0]!;
    expect(offer.bypass).toBe(true);
    // 30 min first, as the work card (owner, 2026-11-09); what is recorded and the conversation come from the server and the session.
    expect([offer.preselected, offer.durations.length, offer.places.length]).toEqual([30 * 60_000, 3, 0]);
    expect([offer.evidence, offer.conversationId]).toEqual(["calls", session.id]);
    expect(s.grants.made).toEqual([]);
    expect(session.toolMode).toBe("ask");

    const allowing = await fixture();
    const other = await allowing.agent.startSession("ask");
    const grant = await other.startBypass("Renaming 400 drawings");

    const made = allowing.grants.made[0]!;
    expect([made.json["kind"], made.json["minutes"], made.headers["x-faden-conversation-id"]]).toEqual(["bypass", 30, other.id]);
    expect(made.json["reason"]).toBe("Renaming 400 drawings");
    expect(String(made.json["client_version"])).toMatch(/^@fadenstack\/agents\//);
    expect(String(made.json["shown_text_sha256"])).toHaveLength(64);
    expect([other.bypass?.id, other.toolMode, other.effectiveToolMode]).toEqual([grant!.id, "bypass", "bypass"]);
  });

  it("runs a destructive call the gateway covers unasked, and the turn is reported", async () => {
    const s = await fixture();
    const session = await s.agent.startSession("ask");
    const grant = (await session.startBypass())!;
    s.script.covered("call-1", "delete_page", { page: 7 }, grant.id).says("Deleted.");

    await session.send("Delete page 7.");

    expect(s.pages.deleted).toEqual([7]);
    expect(s.card.asked).toEqual([]);
    expect(decisions(session)).toMatchObject([{ scope: "grant", grant_id: grant.id }]);
    expect(s.grants.reports).toEqual([{ grant: grant.id, calls: ["call-1"] }]);
    expect(s.gateway.modelCalls[0]!.toolMode).toBe("bypass");
  });

  it("still asks about a call the gateway did not cover, and about an admin's rule", async () => {
    const s = await fixture();
    const session = await s.agent.startSession("ask");
    await session.startBypass();
    s.script.calls({ id: "call-1", name: "delete_page", arguments: { page: 7 } }).says("Not deleted.")
      .reply({ events: [ruleMark("call-2", "write_page", "Comments need approval.")],
        toolCalls: [{ id: "call-2", name: "write_page", arguments: { page: 8, text: "a" } }] }).says("Ok.");

    await session.send("Delete page 7.");
    await session.send("Comment.");

    expect(s.card.asked).toHaveLength(2);
    expect(s.card.asked[1]!.requiredByRule).toBe(true);
    expect(s.pages.deleted).toEqual([]);
    expect(s.pages.pages.get(8)).toBe("Figure F2");
  });

  it("reports only what ran unanswered, not the calls the person allowed", async () => {
    const card = new Card(true, true);
    const s = await fixture({ card });
    const session = await s.agent.startSession("ask");
    const grant = (await session.startBypass())!;
    // One turn: a destructive call the grant covers, a write an admin's rule asks about, a read the mode runs, and a
    // destructive call the gateway did not cover.
    s.script.reply({
      events: [{ type: "CUSTOM", name: "faden.grant_used", value: { toolCallId: "call-1", toolCallName: "delete_page", grantId: grant.id } },
        ruleMark("call-2", "write_page", "Comments need approval.")],
      toolCalls: [{ id: "call-1", name: "delete_page", arguments: { page: 7 } }, { id: "call-2", name: "write_page", arguments: { page: 8, text: "a" } },
        { id: "call-3", name: "read_page", arguments: { page: 7 } }, { id: "call-4", name: "delete_page", arguments: { page: 8 } }],
    }).says("Done.");

    await session.send("Tidy page 7.");

    expect(s.pages.deleted).toEqual([7, 8]);
    expect(card.asked.map((a) => a.toolName)).toEqual(["write_page", "delete_page"]);
    expect(card.asked[0]!.requiredByRule).toBe(true);
    expect(s.grants.reports).toEqual([{ grant: grant.id, calls: ["call-1", "call-3"] }]);
  });

  it("covers nothing of another conversation's Bypass", async () => {
    const s = await fixture();
    const first = await s.agent.startSession("ask");
    const grant = (await first.startBypass())!;
    const second = await s.agent.startSession("bypass");
    s.script.covered("call-1", "delete_page", { page: 7 }, grant.id).says("No.");

    await second.send("Delete page 7.");

    expect(s.pages.deleted).toEqual([]);
    expect(s.card.asked).toHaveLength(1);
    expect(s.grants.reports).toEqual([]);
  });

  it("never lets Bypass answer the gateway's own question: it goes to the person, also with a grant that says it covers it", async () => {
    const s = await fixture({ card: new Card(true, false) });
    const session = await s.agent.startSession("ask");
    const grant = (await session.startBypass())!;
    s.script.reply({
      events: [{ type: "CUSTOM", name: "faden.grant_used", value: { toolCallId: "gw-1", toolCallName: "mcp_github.delete_repo", grantId: grant.id } }],
      gatewayTool: { callId: "gw-1", name: "mcp_github.delete_repo", approval: { message: "Deleting needs your OK.", rule: false, toolClass: "destructive" } },
      text: "Done.",
    });

    await session.send("delete the repo");

    expect(s.card.asked).toMatchObject([{ toolName: "mcp_github.delete_repo", source: "gateway" }]);
    const answer = s.gateway.requests.find((r) => r.path.includes("/approvals/"))!;
    expect(answer.body).toMatchObject({ approved: false });
    expect(s.grants.reports).toEqual([{ grant: grant.id, calls: [] }]);
  });

  it("is ended by Stop, which goes back to the chat's mode, and by leaving Bypass", async () => {
    const s = await fixture();
    const session = await s.agent.startSession("ask");
    const grant = (await session.startBypass())!;

    await session.stopBypass();

    expect([s.grants.status(grant.id), session.toolMode, session.bypass]).toEqual(["revoked", "ask", undefined]);

    const again = (await session.startBypass())!;
    session.toolMode = "auto";
    s.script.says("Fine.");
    await session.send("Go on.");
    expect(s.grants.status(again.id)).toBe("revoked");
  });

  it("is made by an app set to bypass through the same grant without a card, never from read only", async () => {
    const s = await fixture({ configure: (b) => b.usePermissionMode("bypass") });
    const readOnly = await s.agent.startSession("read_only");
    s.script.says("Hello.");
    await readOnly.send("Hi.");
    expect(s.grants.made).toEqual([]);

    const session = await s.agent.startSession("ask");
    s.script.says("Hello.");
    await session.send("Hi.");

    expect(s.card.offers).toEqual([]);
    expect(s.grants.made).toHaveLength(1);
    expect(s.grants.made[0]!.json).toMatchObject({ kind: "bypass", minutes: 60, reason: "PermissionMode.Bypass" });
    expect(session.effectiveToolMode).toBe("bypass");
  });

  it("is never extended, not even a grant an app made without a card", async () => {
    const s = await fixture({ configure: (b) => b.usePermissionMode("bypass") });
    const session = await s.agent.startSession("ask");
    s.script.says("Hello.");
    await session.send("Hi.");
    const grant = session.bypass!;

    expect(await session.offerExtension(grant, 30 * 60_000)).toBeNull();
    await expect(s.agent.grants.extend(grant.id, 30 * 60_000)).rejects.toThrow("not extended");

    expect(s.card.offers).toEqual([]);
    expect(s.grants.extensions).toEqual([]);
    expect(s.grants.status(grant.id)).toBe("active");
  });

  it("records the person's own words from the card, and the card says what the server records", async () => {
    const card = new Card();
    card.reason = "Renaming 400 drawings, as agreed with Anna.";
    const s = await fixture({ approvals: { ...OFFERED, bypass: { ...(OFFERED["bypass"] as object), evidence: "decisions" } }, card });
    const session = await s.agent.startSession("ask");

    await session.startBypass("The app's own words");

    expect(card.offers[0]!.evidence).toBe("decisions");
    expect(s.grants.made[0]!.json["reason"]).toBe("Renaming 400 drawings, as agreed with Anna.");
  });

  it("opens again in Bypass only while its grant lives, else in the mode it had before", async () => {
    const s = await fixture();
    const session = await s.agent.startSession("read_only");
    s.script.says("Read.");
    await session.send("Look.");
    session.toolMode = "ask";
    await session.startBypass();
    s.script.says("Done.");
    await session.send("Go.");
    expect(session.toolMode).toBe("bypass");

    const again = await s.agent.openSession(session.id);
    // Owner, 2026-11-09: parallel chats never break -- its grant lives, so it opens in Bypass, with its marker.
    expect([again.toolMode, again.effectiveToolMode]).toEqual(["bypass", "bypass"]);

    await again.stopBypass();
    expect(again.toolMode).toBe("read_only"); // the mode it had before Bypass
    const later = await s.agent.openSession(session.id);
    expect([later.toolMode, later.effectiveToolMode]).toEqual(["read_only", "read_only"]); // no live grant: never Bypass (sdk/09 L-58)
  });

  it("opens a chat left before its first message in Bypass, and its grant runs on", async () => {
    const s = await fixture();
    const session = await s.agent.startSession("ask");
    const grant = (await session.startBypass())!; // no turn yet: the transcript names no Bypass

    const again = await s.agent.openSession(session.id);
    expect([again.toolMode, again.effectiveToolMode]).toEqual(["bypass", "bypass"]);
    s.script.says("Done.");
    await again.send("Go on.");

    expect(s.grants.status(grant.id)).toBe("active"); // the turn did not take it for a chat that left Bypass
    await again.stopBypass();
    expect(again.toolMode).toBe("ask"); // the mode it had before
  });

  it.each([["admin", "admin"], ["kill_switch", "kill_switch"], ["limit", "limit"]])(
    "says why a grant ended (%s), read from the server once it left the list", async (by, why) => {
      const s = await fixture();
      const session = await s.agent.startSession("ask");
      const grant = (await session.startBypass())!;
      expect(await s.agent.grants.whyEnded(grant.id)).toBeNull(); // it runs

      s.grants.end(grant.id, by);
      await s.agent.grants.refresh();

      expect(session.bypass).toBeUndefined();
      expect(await s.agent.grants.whyEnded(grant.id)).toBe(why);
    });

  it("says why a grant ended here or by its time without the server, and an older server says nothing", async () => {
    const s = await fixture();
    const session = await s.agent.startSession("ask");
    const stopped = (await session.startBypass())!;
    await session.stopBypass();
    const timed = (await session.startBypass())!;
    s.grants.canSayWhy = false;

    expect(await s.agent.grants.whyEnded(stopped.id)).toBe("person");
    s.grants.serverNow += 31 * 60_000;
    await s.agent.grants.refresh();
    expect(await s.agent.grants.whyEnded(timed.id)).toBe("expired");
    expect(await s.agent.grants.whyEnded("g-9")).toBeNull();
    expect(s.gateway.requests.some((r) => r.method === "GET" && r.path.endsWith(`/grants/${stopped.id}`))).toBe(false);
  });

  it("is never started by the model, whatever it says or calls", async () => {
    for (const [tool, args] of [["switch_on_bypass", {}], ["start_bypass", { minutes: 120 }], ["set_tool_mode", { mode: "bypass" }]] as const) {
      const card = new Card(true, true);
      const s = await fixture({ card });
      const session = await s.agent.startSession("auto");
      s.script.calls({ id: "call-1", name: tool, arguments: args }).says("I switched Bypass on. Please confirm Bypass now.");

      await session.send("Please keep asking me less.");

      expect(card.offers).toEqual([]); // no card
      expect(card.opened).toEqual([]); // no browser
      expect([s.grants.stepUpsStarted, s.grants.made.length]).toEqual([0, 0]);
      expect([session.toolMode, session.effectiveToolMode]).toEqual(["auto", "auto"]);
      expect(session.bypass).toBeUndefined();
    }
  });

  it("tells the model once, in its next request, that Bypass ended", async () => {
    const s = await fixture();
    const session = await s.agent.startSession("ask");
    const grant = (await session.startBypass())!;
    s.script.says("In Bypass.");
    await session.send("One.");
    s.grants.end(grant.id, "admin");
    await s.agent.grants.refresh();
    await session.stopBypass();
    s.script.says("Asking again.").says("Still asking.");

    await session.send("Two.");
    await session.send("Three.");

    const mentions = (i: number) => s.gateway.modelCalls[i]!.messages.some((m) => m.role === "system" && typeof m.content === "string"
      && m.content.includes(BYPASS_ENDED_NOTE));
    expect([0, 1, 2].map(mentions)).toEqual([false, true, false]);
    // before the person's newest message
    const second = s.gateway.modelCalls[1]!.messages;
    expect(second[second.length - 2]).toMatchObject({ role: "system" });
    expect(second[second.length - 1]).toMatchObject({ role: "user" });
  });

  it("announces the flow on every request, only where the app can open the second sign-in", async () => {
    const s = await fixture();
    await s.agent.start();
    const profile = s.gateway.requests.find((r) => r.path === "/v1/agents/docs/profile")!;
    expect(profile.headers["x-faden-client-supports"]).toBe("tool_mode.bypass, bypass.step_up");

    // An approval handler that is no step-up handler: nothing is announced, so the server offers no Bypass.
    const plain = await setup({ grants: { approvals: OFFERED }, agents: [{ slug: "docs", maxLevel: "bypass" }] }, () => ({ approved: false }));
    await plain.agent.start();
    expect(plain.gateway.requests.filter((r) => r.headers["x-faden-client-supports"] !== undefined)).toEqual([]);
    expect([plain.agent.bypassOffered, plain.agent.ceiling]).toEqual([false, "auto"]);
  });

  it("is announced by an app's own step-up handler beside a plain approval handler", async () => {
    const opener = new Card();
    const s = await setup({ grants: { approvals: OFFERED }, agents: [{ slug: "docs", maxLevel: "bypass" }] }, () => ({ approved: false }),
      (b) => b.useStepUpHandler(opener));
    await s.agent.start();
    expect(s.gateway.requests.find((r) => r.path.endsWith("/profile"))!.headers["x-faden-client-supports"]).toBe("tool_mode.bypass, bypass.step_up");
    expect(s.agent.bypassOffered).toBe(true);
  });
});

/** The second sign-in before Bypass is switched on (sdk/41). Port of the .NET BypassStepUpTests. */
describe("the second sign-in", () => {
  it("is started by Allow and the grant carries its proof", async () => {
    const s = await fixture();
    s.grants.pendingPolls = 2;
    const session = await s.agent.startSession("ask");

    const grant = await session.startBypass();

    expect(grant).not.toBeNull();
    expect(s.card.opened).toHaveLength(1);
    const opened = s.card.opened[0]!;
    expect([opened.link.href, opened.userCode, opened.conversationId]).toEqual(["https://faden.test/step-up#code=BCDF-GHJK", "BCDF-GHJK", session.id]);
    expect(opened.expiresAt.getTime()).toBeGreaterThan(Date.now() + 590_000);
    expect(s.card.stages).toEqual(["browser", "approved"]);
    expect(s.grants.stepUps).toEqual([{ longest: 60 }]); // the page shows the card's longest time
    expect(s.grants.made[0]!.headers["x-faden-step-up"]).toMatch(/^proof-1-/);
    expect(session.effectiveToolMode).toBe("bypass");
  });

  it("starts nowhere without the person's allow", async () => {
    const s = await fixture({ card: new Card(false) });
    const session = await s.agent.startSession("ask");

    expect(await session.startBypass()).toBeNull();

    expect([s.grants.stepUpsStarted, s.grants.made.length]).toEqual([0, 0]);
    expect(s.card.opened).toEqual([]);
  });

  it("serves parallel chats with one sign-in while it is fresh", async () => {
    const s = await fixture();
    const first = await s.agent.startSession("ask");
    const second = await s.agent.startSession("ask");

    await Promise.all([first.startBypass(), second.startBypass()]);

    expect(s.grants.stepUpsStarted).toBe(1);
    expect(s.grants.made).toHaveLength(2);
    expect(new Set(s.grants.made.map((m) => m.headers["x-faden-step-up"])).size).toBe(1);
    expect(first.bypass).toBeDefined();
    expect(second.bypass).toBeDefined();
    expect(first.bypass!.id).not.toBe(second.bypass!.id);
  });

  it("keeps a chat's grant when a list read before it started Bypass comes back after", async () => {
    // Another chat's refresh (a chat opened again, the lifecycle's tick) read the server's list just before this chat's
    // grant was made. Before, the copy became that list: the chat lost its grant, ran without it, and its Stop could not
    // end it at the server. The .NET SDK's A_list_read_before_a_chat_started_bypass_does_not_lose_that_chats_grant.
    const s = await fixture();
    const session = await s.agent.startSession("ask");
    const stale = await s.client.agent!.listGrants();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(s.client.agent!, "listGrants").mockImplementationOnce(async () => { await gate; return stale; });
    const refresh = s.agent.grants.refresh();

    const grant = await session.startBypass();
    release();
    await refresh;

    expect(grant).toBeDefined();
    expect(session.bypass?.id).toBe(grant!.id);
    await session.stopBypass();
    expect(s.grants.status(grant!.id)).toBe("revoked");
  });

  it("keeps a chat's grant under a stream's snapshot from before it started Bypass, and a later snapshot decides", async () => {
    const s = await fixture();
    const session = await s.agent.startSession("ask");
    const before = s.grants.snapshot(); // another chat's stream: read when that chat's request came, before this grant
    const since = s.agent.grants.generation;
    const grant = await session.startBypass();

    s.agent.grants.snapshot(before, since);
    expect(session.bypass?.id).toBe(grant!.id);

    s.agent.grants.snapshot(before, s.agent.grants.generation); // asked for after the grant came: the server's word
    expect(session.bypass).toBeUndefined();
  });

  it("asks once more, without a new token, for a proof the server no longer takes", async () => {
    const s = await fixture();
    await (await s.agent.startSession("ask")).startBypass();
    s.grants.proofsGoStale(); // older than 5 minutes by the server's clock
    const later = await s.agent.startSession("ask");

    expect(await later.startBypass()).not.toBeNull();

    expect(s.grants.stepUpsStarted).toBe(2);
    expect(grantPosts(s)).toHaveLength(3); // the refused one, then the one with the new proof
    expect(s.gateway.requests.some((r) => r.path.endsWith("/agent-tokens/refresh"))).toBe(false);
  });

  it("does not use a proof close to its end", async () => {
    const s = await fixture();
    await (await s.agent.startSession("ask")).startBypass();
    expect(s.agent.stepUps.fresh).toBeDefined();
    const now = Date.now();
    s.agent.clock = () => now + 276_000; // the proof lasts 290 s, less the 15 s the request may need
    expect(s.agent.stepUps.fresh).toBeUndefined();
  });

  it.each([["denied", "denied"], ["expired", "timed_out"]] as const)("leaves Bypass off when the sign-in is %s", async (outcome, stage) => {
    const s = await fixture();
    s.grants.stepUpOutcome = outcome;
    const session = await s.agent.startSession("ask");

    const refused = await session.startBypass().catch((e: unknown) => e);

    expect(refused).toBeInstanceOf(BypassSignInError);
    expect((refused as BypassSignInError).stage).toBe(stage);
    expect(s.card.stages.at(-1)).toBe(stage);
    expect(s.grants.made).toEqual([]);
    expect([session.toolMode, session.effectiveToolMode]).toEqual(["ask", "ask"]);
    expect(s.agent.stepUps.fresh).toBeUndefined();
  });

  it("leaves Bypass off when the browser cannot be opened", async () => {
    const card = new Card();
    card.canOpen = false;
    const s = await fixture({ card });
    const session = await s.agent.startSession("ask");

    const refused = await session.startBypass().catch((e: unknown) => e);

    expect((refused as BypassSignInError).stage).toBe("failed");
    expect(s.grants.made).toEqual([]);
  });

  it("polls slower when the server says slow_down", async () => {
    const s = await fixture();
    const waits: number[] = [];
    s.agent.stepUps.delay = (ms) => { waits.push(ms); return Promise.resolve(); };
    s.grants.pendingPolls = 1;
    s.grants.slowDown = 3;
    const session = await s.agent.startSession("ask");

    await session.startBypass();

    // 1 s first; pending; then slow_down with 3 s -> 1 + 5 s; then approved
    expect(waits).toEqual([1000, 1000, 6000]);
  });

  it("stops waiting when the app does, and says so", async () => {
    const s = await fixture();
    s.grants.pendingPolls = 100;
    const controller = new AbortController();
    const session = await s.agent.startSession("ask");
    s.agent.stepUps.delay = () => { controller.abort(new Error("stop")); return Promise.reject(controller.signal.reason); };

    await expect(session.startBypass(undefined, controller.signal)).rejects.toThrow("stop");

    expect(s.card.stages).toEqual(["browser", "cancelled"]);
    expect(s.grants.made).toEqual([]);
  });

  it("makes a session of an app set to bypass run in auto when the app opens no second sign-in", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const s = await setup({ grants: { approvals: OFFERED }, agents: [{ slug: "docs", maxLevel: "bypass" }] }, () => ({ approved: false }),
      (b) => b.usePermissionMode("bypass").useApprovals(denyAllApprovals));
    const session = await s.agent.startSession("ask");

    await session.send("Hi.");

    expect([s.gateway.grants!.stepUpsStarted, s.gateway.grants!.made.length]).toEqual([0, 0]);
    expect(session.effectiveToolMode).toBe("auto");
    expect(s.gateway.modelCalls[0]!.toolMode).toBe("auto");
    expect(warn).toHaveBeenCalled();
  });

  it("needs the second sign-in for an app set to bypass too, and runs in auto when it does not happen", async () => {
    const opener = new Card();
    const s = await fixture({ configure: (b) => b.usePermissionMode("bypass").useApprovals(denyAllApprovals).useStepUpHandler(opener) });
    s.agent.stepUps.delay = () => Promise.resolve();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const session = await s.agent.startSession("ask");
    s.script.says("Hello.");

    await session.send("Hi.");

    expect(opener.opened).toHaveLength(1);
    expect(s.grants.made[0]!.headers["x-faden-step-up"]).toMatch(/^proof-/);
    expect(session.effectiveToolMode).toBe("bypass");

    s.grants.stepUpOutcome = "denied";
    s.grants.proofsGoStale();
    s.agent.stepUps.forget();
    const refused = await s.agent.startSession("ask");
    s.script.says("Hello.");
    await refused.send("Hi."); // no sign-in, no Bypass: the turn runs in auto, nothing thrown
    expect(refused.effectiveToolMode).toBe("auto");
    expect(warn).toHaveBeenCalled();
  });

  it("starts at 30 minutes, and where those are not offered at the longest that is", async () => {
    const card = new Card(false);
    const s = await fixture({ approvals: { ...OFFERED, bypass: { ...(OFFERED["bypass"] as object), longest_minutes: 15 } }, card });
    const session = await s.agent.startSession("ask");

    await session.startBypass();

    expect(card.offers[0]!.preselected).toBe(15 * 60_000);
    expect(card.offers[0]!.durations).toEqual([15 * 60_000]);
  });

  it("never lets a card widen the offer: the time is within the offered ones", async () => {
    const card = new Card(true, false, (offer: GrantOffer): GrantAnswer => ({ allowed: true, places: [], duration: 10 * 3_600_000, shownText: "x" }));
    const s = await fixture({ card });
    const session = await s.agent.startSession("ask");

    await session.startBypass();

    expect(s.grants.made[0]!.json["minutes"]).toBe(60);
  });

  it("cuts the reason at a character's end, never inside a surrogate pair", async () => {
    const { cutReason } = await import("@fadenstack/agents");
    const reason = `${"x".repeat(499)}\u{1F600}`; // the emoji is UTF-16 units 499 and 500
    expect(cutReason(reason)).toBe("x".repeat(499));
    expect(cutReason(`${"x".repeat(498)}\u{1F600}tail`)).toBe(`${"x".repeat(498)}\u{1F600}`);
    expect(cutReason("short")).toBe("short");

    const s = await fixture();
    const session = await s.agent.startSession("ask");
    await s.agent.grants.grantBypass(30 * 60_000, session.id, `${reason}more`);
    const sent = String(s.grants.made[0]!.json["reason"]);
    expect(sent).toHaveLength(499);
    expect(/[\ud800-\udfff]/.test(sent)).toBe(false);
  });

  it("is paused by the app's end, and the next start resumes it without a card or a sign-in", async () => {
    const s = await fixture();
    const session = await s.agent.startSession("ask");
    const grant = (await session.startBypass())!;

    expect(await s.agent.grants.pauseBypass()).toHaveLength(1);
    expect(s.grants.status(grant.id)).toBe("paused");
    expect(session.bypass).toBeUndefined(); // paused: nothing runs under it

    s.grants.serverNow += 20 * 60_000;
    expect(await s.agent.grants.resumeBypass()).toEqual([]);

    expect(s.grants.status(grant.id)).toBe("active");
    expect([s.card.offers.length, s.grants.stepUpsStarted, s.grants.made.length]).toEqual([1, 1, 1]);
  });

  it("ends a Bypass paused too long, or no longer allowed, instead of resuming it, and says why", async () => {
    const s = await fixture();
    // An hour each, so they outlive the pause.
    const long = await s.agent.grants.grantBypass(3_600_000, (await s.agent.startSession("ask")).id);
    const narrowed = await s.agent.grants.grantBypass(3_600_000, (await s.agent.startSession("ask")).id);
    await s.agent.grants.pause(long.id);
    s.grants.serverNow += 31 * 60_000;
    await s.agent.grants.pause(narrowed.id);
    s.grants.refuseResume = 403; // the organisation's Bypass list stopped naming the person

    const ended = await s.agent.grants.resumeBypass();

    expect(ended.map((e) => [e.grant.id, e.why]).sort()).toEqual([[long.id, "paused_too_long"], [narrowed.id, "limit"]]);
    expect([s.grants.status(long.id), s.grants.status(narrowed.id)]).toEqual(["revoked", "revoked"]);
  });

  it("says ended, not thrown, for a Bypass the server ended after the list was read", async () => {
    const s = await fixture();
    const grant = (await (await s.agent.startSession("ask")).startBypass())!;
    await s.agent.grants.pause(grant.id);
    s.grants.refuseResume = 404; // Bypass turned off between the list and the resume

    const ended = await s.agent.grants.resumeBypass();

    expect(ended.map((e) => [e.grant.id, e.why])).toEqual([[grant.id, "kill_switch"]]);
    expect(s.grants.status(grant.id)).toBe("revoked");
  });

  it("keeps a Bypass paused whose check cannot run", async () => {
    const s = await fixture();
    const grant = (await (await s.agent.startSession("ask")).startBypass())!;
    await s.agent.grants.pause(grant.id);
    s.grants.refuseResume = 503;

    const ended = await s.agent.grants.resumeBypass();

    expect(ended.map((e) => [e.grant.id, e.why])).toEqual([[grant.id, "unavailable"]]);
    expect(s.grants.status(grant.id)).toBe("paused");
  });

  it("holds the proof in memory only: it is in no transcript, store, record or report", async () => {
    const s = await fixture();
    const session = await s.agent.startSession("ask");
    await session.startBypass();
    s.script.says("Hi.");
    await session.send("Hi.");
    await s.agent.flush();
    const proof = s.agent.stepUps.fresh!;
    expect(proof).toMatch(/^proof-/);
    const kept = JSON.stringify([session.transcript, await s.store.read("docs", session.id), s.gateway.reported, s.gateway.modelCalls.map((c) => c.body)]);
    expect(kept).not.toContain(proof);
    expect(kept).not.toContain("device-code");
  });
});
