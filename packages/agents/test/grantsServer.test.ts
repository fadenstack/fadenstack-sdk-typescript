import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ApprovalDecision,
  BypassSignInError,
  GrantPlace,
  isLocalPath,
  namesPath,
  placeLies,
  placeNamed,
  type AgentEvent,
  type GrantPlaceResolver,
} from "@fadenstack/agents";
import { setup } from "./helpers.js";
import { Card, decisions, fixture, grantUsed } from "./grantHelpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const reportedDecisions = (s: { gateway: { reported: Record<string, unknown>[] } }) => s.gateway.reported.filter((e) => e["type"] === "approval.decided");
const resolve: GrantPlaceResolver = async (place) => place;

/** Grants held by the server (sdk/38 §6, §7; sdk/40 A2.2). Port of the .NET GrantTests. */
describe("grants the server holds", () => {
  it("offers a time within the agent's longest grant for reads and writes only", async () => {
    const card = new Card(true, true);
    const s = await fixture({ card, approvals: { standing: ["time"], longest_grant_minutes: 60, grant_classes: ["read", "write"] } });
    const session = await s.agent.startSession("ask");
    s.script.calls({ id: "call-1", name: "write_page", arguments: { page: 8, text: "Fine." } }).says("Done.")
      .calls({ id: "call-2", name: "delete_page", arguments: { page: 7 } }).says("Done.");

    await session.send("Comment.");
    await session.send("Delete.");

    expect(card.asked[0]!.grantDurations).toEqual([15, 30, 60].map((m) => m * 60_000));
    expect([card.asked[0]!.canAllowForSession, card.asked[0]!.canAllowAlways]).toEqual([false, false]); // the agent offers only "time"
    expect(card.asked[1]!.grantDurations).toBeUndefined(); // never for a destructive tool
  });

  it("is as before for a server without grants", async () => {
    const s = await setup({ model: () => ({ text: "x" }) }, () => ApprovalDecision.approve());
    await s.agent.start();
    expect([s.agent.grants.available, s.agent.grants.settings, s.agent.grants.choices, s.agent.grants.bypassChoices]).toEqual([false, undefined, [], []]);
  });

  it("offers nothing from an `approvals` block the server does not mark with approval_scopes.grant", async () => {
    const s = await setup({}, () => ApprovalDecision.approve());
    const api = s.client.agent!, original = api.getProfile.bind(api);
    vi.spyOn(api, "getProfile").mockImplementation(async (signal) => ({
      ...(await original(signal)),
      principal: { tenantId: "t", userId: "u", agentId: "a", deviceId: "d" },
      approvals: { standing: null, longestGrantMinutes: 120, grantClasses: ["read", "write"] },
    }));
    await s.agent.start();
    expect([s.agent.grants.settings, s.agent.grants.choices, s.agent.grants.offers("time"), s.agent.grants.bypassChoices]).toEqual([undefined, [], false, []]);
  });

  it("makes a grant on the server for Allow for a time, and says so in the record", async () => {
    const s = await fixture({ configure: (b) => b.useApprovals(() => Promise.resolve(ApprovalDecision.approveFor(30 * 60_000))) });
    const session = await s.agent.startSession("ask");
    s.script.calls({ id: "call-1", name: "write_page", arguments: { page: 8, text: "Fine." } }).says("Done.");
    const decided: AgentEvent[] = [];

    for await (const e of session.stream("Comment.")) if (e.type === "approval_decided") decided.push(e);
    await s.agent.flush();

    expect(s.grants.made[0]!.json).toMatchObject({ kind: "time", tools: ["write_page"], minutes: 30 });
    expect(s.pages.pages.get(8)).toBe("Fine.");
    expect(decisions(session)).toMatchObject([{ scope: "grant", grant_id: "g-1", grant_minutes: 30 }]);
    expect(decided[0]).toMatchObject({ decision: { forTime: 30 * 60_000 } });
    expect(reportedDecisions(s)).toMatchObject([{ scope: "grant", grant_id: "g-1" }]);
    expect(s.agent.grants.live.map((g) => g.id)).toEqual(["g-1"]);
  });

  it("takes a grant the server refuses for no grant: the call is allowed once and the chat says so", async () => {
    const s = await fixture({ configure: (b) => b.useApprovals(() => Promise.resolve(ApprovalDecision.approveFor(30 * 60_000))) });
    s.grants.refuse = "grant_not_offered";
    const session = await s.agent.startSession("ask");
    s.script.calls({ id: "call-1", name: "write_page", arguments: { page: 8, text: "Fine." } }).says("Done.");
    const notices: string[] = [];

    for await (const e of session.stream("Comment.")) if (e.type === "notice") notices.push(e.notice.outcome);

    expect(decisions(session)).toMatchObject([{ scope: "once" }]);
    expect(notices).toContain("grant_failed");
    expect(s.agent.grants.live).toEqual([]);
  });

  it("runs a call the gateway says a grant covers without asking when the grant holds", async () => {
    const s = await fixture();
    const id = s.grants.hold("time", { tools: ["write_page"] });
    s.script.covered("call-1", "write_page", { page: 8, text: "Fine." }, id).says("Done.");
    const session = await s.agent.startSession("ask");

    await session.send("Comment.");
    await s.agent.flush();

    expect(s.card.asked).toEqual([]);
    expect(decisions(session)).toMatchObject([{ scope: "grant", grant_id: id, asked: false }]);
    expect(reportedDecisions(s)).toMatchObject([{ scope: "grant", grant_id: id }]);
  });

  it("keeps the gateway's word on a call for its round only: a reused id later asks", async () => {
    const s = await fixture();
    const id = s.grants.hold("time", { tools: ["write_page"] });
    s.script.covered("call-1", "write_page", { page: 8, text: "Fine." }, id)
      .calls({ id: "call-1", name: "write_page", arguments: { page: 8, text: "Fine." } }).says("Done.");
    const session = await s.agent.startSession("ask");

    await session.send("Comment twice.");

    expect(s.card.asked).toHaveLength(1);
    expect(decisions(session).map((d) => d["scope"])).toEqual(["grant", null]);
  });

  it.each([["revoked", "write_page"], ["paused", "write_page"], ["active", "read_page"]] as const)(
    "asks when the grant (%s, for %s) does not hold for this call", async (status, grantedTool) => {
      const s = await fixture({ card: new Card(true, true) });
      const id = s.grants.hold("time", { tools: [grantedTool] }, 30, status);
      s.script.covered("call-1", "write_page", { page: 8, text: "Fine." }, id).says("Done.");
      const session = await s.agent.startSession("ask");

      await session.send("Comment.");

      expect(s.card.asked).toHaveLength(1);
      expect(decisions(session)).toMatchObject([{ scope: "once" }]);
    });

  it("replaces the copy with a stream's list, so a grant ended elsewhere covers nothing", async () => {
    const s = await fixture();
    const id = s.grants.hold("time", { tools: ["write_page"] });
    await s.agent.start();
    await s.agent.grants.refresh();
    expect(s.agent.grants.live.map((g) => g.id)).toEqual([id]);
    s.script.reply({ events: [{ type: "CUSTOM", name: "faden.grants", value: { serverNow: new Date(s.grants.serverNow).toISOString(), grants: [] } }], text: "Hi." });
    const session = await s.agent.startSession("ask");

    await session.send("Hello.");

    expect(s.agent.grants.live).toEqual([]);
  });

  it("covers a stretch of work only for calls that name their place", async () => {
    const contract = [{ name: "write_page", risk: "write" as const, target_type: "document", target_argument: "/text" }, { name: "read_page", risk: "read" as const }];
    const s = await fixture({ contract, card: new Card(true, true), configure: (b) => b.useGrantPlaceResolver(resolve) });
    const id = s.grants.hold("work", { classes: ["write"], targets: [{ type: "document", identifiers: ["Fine."] }] });
    s.script.covered("call-1", "write_page", { page: 8, text: "Fine." }, id).says("Done.")
      .covered("call-2", "write_page", { page: 8, text: "" }, id).says("Done.");
    const session = await s.agent.startSession("ask");

    await session.send("Comment.");
    await session.send("Comment without text.");

    expect(s.card.asked).toHaveLength(1);
    expect(decisions(session).map((d) => d["scope"])).toEqual(["grant", "once"]);
  });

  it("makes the grant for a gateway wait answered for a time, and answers the wait once", async () => {
    const s = await fixture({ configure: (b) => b.useApprovals(() => Promise.resolve(ApprovalDecision.approveFor(3_600_000))) });
    const session = await s.agent.startSession("ask");
    s.script.reply({ gatewayTool: { name: "mcp.github.comment", approval: { message: "The tool mode asks.", timeoutS: 300, toolClass: "write", rule: false } },
      text: "Commented." });

    await session.send("Comment on the issue.");

    expect(s.grants.made[0]!.json["tools"]).toEqual(["mcp.github.comment"]);
    const answer = s.gateway.requests.find((r) => r.path.includes("/approvals/approval-"))!;
    expect(answer.body).toMatchObject({ approved: true, scope: "once" });
  });

  it("offers a stretch of work with places the person may remove, belonging to the chat", async () => {
    const report = GrantPlace.document("C:\\Docs\\report.docx");
    const site = GrantPlace.site("https://purchase.example.de");
    const card = new Card(true, false, (offer) => ({ allowed: true, places: [report], duration: offer.preselected, shownText: "Work alongside you for 30 min?" }));
    const s = await fixture({ card, configure: (b) => b.useGrantPlaceResolver(resolve) });
    const session = await s.agent.startSession("ask");

    const grant = await session.offerWork([report, site], "To fill in the order.");

    const offer = card.offers[0]!;
    expect([offer.preselected, offer.durations.length, offer.reason]).toEqual([30 * 60_000, 4, "To fill in the order."]);
    expect(offer.classes).toEqual(["read", "write"]);
    const made = s.grants.made[0]!;
    expect(made.headers["x-faden-conversation-id"]).toBe(session.id);
    expect(made.json["targets"]).toEqual([{ type: "document", identifiers: ["C:\\Docs\\report.docx"] }]);
    expect(String(made.json["shown_text_sha256"])).toHaveLength(64);
    expect([grant!.id, grant!.conversationId]).toEqual(["g-1", session.id]);
  });

  it("offers no stretch of work where the agent does not offer it or the person says not now", async () => {
    const card = new Card(false);
    const s = await fixture({ card, approvals: { standing: ["chat", "time"], longest_grant_minutes: 120, grant_classes: ["read", "write"] },
      configure: (b) => b.useGrantPlaceResolver(resolve) });
    const session = await s.agent.startSession("ask");

    expect(await session.offerWork([GrantPlace.folder("/srv/share")])).toBeNull();
    expect(card.offers).toEqual([]);

    s.grants.approvals = { standing: null, longest_grant_minutes: 120, grant_classes: ["read", "write"] };
    await s.agent.restart();
    const again = await s.agent.startSession("ask");
    expect(await again.offerWork([GrantPlace.folder("/srv/share")])).toBeNull();
    expect(card.offers).toHaveLength(1);
    expect(s.grants.made).toEqual([]);
  });

  it("extends a running grant in place, the cap being the server's", async () => {
    const card = new Card(true, false, (offer) => ({ allowed: true, places: offer.places, duration: offer.preselected }));
    const s = await fixture({ card, configure: (b) => b.useGrantPlaceResolver(resolve) });
    s.grants.longestMinutes = 60;
    const session = await s.agent.startSession("ask");
    const grant = (await session.offerWork([GrantPlace.document("/plan.docx")]))!;
    const more = GrantPlace.document("/budget.xlsx");

    const extended = await session.offerExtension(grant, 45 * 60_000, [more]);

    const offer = card.offers.at(-1)!;
    expect([offer.extending!.id, offer.places]).toEqual([grant.id, [more]]);
    expect(s.grants.extensions[0]!.json).toMatchObject({ minutes: 45, targets: [{ type: "document", identifiers: ["/budget.xlsx"] }] });
    expect(extended!.narrowed).toEqual(["minutes"]);
    expect(Date.parse(extended!.expiresAt)).toBe(Date.parse(grant.issuedAt!) + 60 * 60_000);
  });

  it("counts the marker down by the server's clock, and Stop ends every grant", async () => {
    const card = new Card(true, false, (offer) => ({ allowed: true, places: offer.places, duration: 30 * 60_000 }));
    const s = await fixture({ card, configure: (b) => b.useGrantPlaceResolver(resolve) });
    s.grants.serverNow = Date.now() + 3 * 3_600_000; // the device's clock is three hours behind
    const session = await s.agent.startSession("ask");
    await session.offerWork([GrantPlace.document("/plan.docx")]);
    await s.agent.grants.grantForTime("write_page", 15 * 60_000);

    const left = s.agent.grants.remaining(s.agent.grants.live[0]!);
    expect(left).toBeGreaterThanOrEqual(14 * 60_000);
    expect(left).toBeLessThanOrEqual(15 * 60_000);
    let changes = 0;
    s.agent.grants.onChanged(() => changes++);

    await s.agent.grants.revokeAll();

    expect(s.agent.grants.live).toEqual([]);
    expect([s.grants.status("g-1"), s.grants.status("g-2")]).toEqual(["revoked", "revoked"]);
    expect(changes).toBe(2);
  });
});

/** The checks around grants the server holds (sdk/43 §4, sdk/46 C6). Port of the .NET GrantHardeningTests. */
describe("the checks around grants", () => {
  it("keeps a grant that is what was asked", async () => {
    const s = await fixture();
    await s.agent.start();
    const grant = await s.agent.grants.grantForTime("write_page", 30 * 60_000, "chat-1");
    expect(s.agent.grants.live.map((g) => g.id)).toEqual([grant.id]);
  });

  it.each([
    ["longer", (g: Record<string, unknown>, now: number) => { g["expires_at"] = new Date(now + 90 * 60_000).toISOString(); }],
    ["another tool", (g: Record<string, unknown>) => { g["scope"] = { tools: ["delete_page"] }; }],
    ["two tools", (g: Record<string, unknown>) => { g["scope"] = { tools: ["write_page", "delete_page"] }; }],
    ["another kind", (g: Record<string, unknown>) => { g["kind"] = "bypass"; }],
    ["not active", (g: Record<string, unknown>) => { g["status"] = "paused"; }],
    ["no time left", (g: Record<string, unknown>, now: number) => { g["expires_at"] = new Date(now).toISOString(); }],
    ["another conversation", (g: Record<string, unknown>) => { g["conversation_id"] = "chat-2"; }],
    ["another agent", (g: Record<string, unknown>) => { g["agent_id"] = "a-2"; }],
    ["another agent version", (g: Record<string, unknown>) => { g["agent_version"] = 2; }],
    ["another device", (g: Record<string, unknown>) => { g["device_id"] = "device-8"; }],
  ])("refuses and never keeps a grant that exceeds or differs from the request (%s)", async (_why, change) => {
    const s = await fixture();
    await s.agent.start();
    s.grants.tamper = (g) => change(g, s.grants.serverNow);

    await expect(s.agent.grants.grantForTime("write_page", 30 * 60_000, "chat-1")).rejects.toThrow();

    expect(s.agent.grants.live).toEqual([]);
    expect(s.agent.grants.find("g-1")).toBeUndefined();
  });

  it("takes a refused grant in a chat for no grant: allowed once, and the chat says so", async () => {
    const s = await fixture({ configure: (b) => b.useApprovals(() => Promise.resolve(ApprovalDecision.approveFor(30 * 60_000))) });
    s.grants.tamper = (g) => { g["expires_at"] = new Date(s.grants.serverNow + 90 * 60_000).toISOString(); };
    const session = await s.agent.startSession("ask");
    s.script.calls({ id: "call-1", name: "write_page", arguments: { page: 8, text: "Fine." } }).says("Done.");
    const notices: string[] = [];

    for await (const e of session.stream("Comment.")) if (e.type === "notice") notices.push(e.notice.outcome);

    const record = decisions(session)[0]!;
    expect(record["scope"]).toBe("once");
    expect(record["grant_confirmed_minutes"]).toBeUndefined();
    expect(notices).toContain("grant_failed");
    expect(s.agent.grants.live).toEqual([]);
  });

  it("does not keep an answer about a grant of another agent version: the copy stays as it was", async () => {
    const s = await fixture();
    await s.agent.start();
    const made = await s.agent.grants.grantForTime("write_page", 30 * 60_000);
    s.grants.tamperShown = (g) => { g["agent_version"] = 9; };

    await expect(s.agent.grants.pause(made.id)).rejects.toThrow("another agent version");
    await expect(s.agent.grants.extend(made.id, 15 * 60_000)).rejects.toThrow("another agent version");

    expect([s.agent.grants.find(made.id)!.status, s.agent.grants.find(made.id)!.agentVersion]).toEqual(["active", 1]);
  });

  it("refuses a work grant with a place or class that was not asked", async () => {
    const s = await fixture({ configure: (b) => b.useGrantPlaceResolver(resolve) });
    await s.agent.start();
    const report = GrantPlace.document("C:\\Docs\\report.docx");
    s.grants.tamper = (g) => { g["scope"] = { classes: ["read", "write"], targets: [{ type: "document", identifiers: ["C:\\Docs\\report.docx", "C:\\Docs\\secret.docx"] }] }; };
    await expect(s.agent.grants.grantWork([report], 30 * 60_000, "chat-1")).rejects.toThrow("exceeds");
    s.grants.tamper = (g) => { g["scope"] = { classes: ["read", "write", "destructive"], targets: [{ type: "document", identifiers: ["C:\\Docs\\report.docx"] }] }; };
    await expect(s.agent.grants.grantWork([report], 30 * 60_000, "chat-1")).rejects.toThrow("exceeds");
    expect(s.agent.grants.live).toEqual([]);

    s.grants.tamper = undefined;
    const kept = await s.agent.grants.grantWork([report], 30 * 60_000, "chat-1");
    expect(s.agent.grants.live.map((g) => g.id)).toEqual([kept.id]);
  });

  it("refuses a Bypass grant longer than the confirmed time", async () => {
    const s = await fixture();
    s.grants.tamper = (g) => { g["expires_at"] = new Date(s.grants.serverNow + 120 * 60_000).toISOString(); };
    const session = await s.agent.startSession("ask");

    await expect(session.startBypass()).rejects.toThrow("exceeds");

    expect(session.bypass).toBeUndefined();
    expect(session.effectiveToolMode).toBe("ask");
    expect(session.toolMode).toBe("ask");
  });

  it("keeps the minutes the server confirmed beside the minutes the person picked", async () => {
    const s = await fixture({ configure: (b) => b.useApprovals(() => Promise.resolve(ApprovalDecision.approveFor(30 * 60_000))) });
    s.grants.longestMinutes = 15; // the server cuts the 30 minutes to 15
    const session = await s.agent.startSession("ask");
    s.script.calls({ id: "call-1", name: "write_page", arguments: { page: 8, text: "Fine." } }).says("Done.");
    const decided: AgentEvent[] = [];

    for await (const e of session.stream("Comment.")) if (e.type === "approval_decided") decided.push(e);

    expect(decisions(session)[0]).toMatchObject({ grant_minutes: 30, grant_confirmed_minutes: 15 });
    expect(decided[0]).toMatchObject({ decision: { forTime: 15 * 60_000 } });
  });

  it("covers one call, once, with a gateway mark: the same wait asked again is not covered again", async () => {
    const s = await fixture();
    const id = s.grants.hold("time", { tools: ["mcp.github.comment"] });
    s.gateway.acceptApprovals("ap-1", "ap-2");
    const wait = (approvalId: string) => ({ type: "CUSTOM", name: "faden.approval_required", value: {
      approvalId, toolCallId: "gw-1", toolCallName: "mcp.github.comment", message: "The tool mode asks.", timeoutS: 300, toolClass: "write", rule: false } });
    s.script.reply({ events: [grantUsed("gw-1", "mcp.github.comment", id), wait("ap-1"), wait("ap-2")], text: "Done." });
    const session = await s.agent.startSession("ask");

    await session.send("Comment.");

    expect(s.card.asked).toHaveLength(1);
    expect(decisions(session).map((d) => d["scope"])).toEqual(["grant", null]);
  });

  it("does not let a mark for one tool cover a call of another with the same id", async () => {
    const s = await fixture();
    const id = s.grants.hold("time", { tools: ["write_page"] });
    s.script.reply({ events: [grantUsed("call-1", "read_page", id)], toolCalls: [{ id: "call-1", name: "write_page", arguments: { page: 8, text: "Fine." } }] }).says("Done.");
    const session = await s.agent.startSession("ask");

    await session.send("Comment.");

    expect(s.card.asked).toHaveLength(1);
    expect(s.pages.pages.get(8)).toBe("Figure F2");
  });

  describe.each([
    ["grants is not a list", (v: any) => ({ ...v, grants: "nope" })],
    ["no list", (v: any) => ({ serverNow: v.serverNow })],
    ["no server time", (v: any) => ({ grants: v.grants })],
    ["not an object", () => "nope"],
    ["a grant of another agent", (v: any) => ({ ...v, grants: [{ ...v.grants[0], agent_id: "a-2" }] })],
    ["a grant of another device", (v: any) => ({ ...v, grants: [{ ...v.grants[0], device_id: "device-8" }] })],
  ])("a malformed snapshot (%s)", (_why, malform) => {
    it("clears the cached grants, not just the bad entry", async () => {
      const s = await fixture();
      s.grants.hold("time", { tools: ["write_page"] });
      await s.agent.start();
      await s.agent.grants.refresh();
      expect(s.agent.grants.live).toHaveLength(1);
      s.script.reply({ events: [{ type: "CUSTOM", name: "faden.grants", value: malform(s.grants.snapshot()) }], text: "Hi." });
      const session = await s.agent.startSession("ask");

      await session.send("Hello.");

      expect(s.agent.grants.live).toEqual([]);
      expect(s.agent.grants.find("g-1")).toBeUndefined();
    });
  });

  it("leaves a grant this SDK cannot read out of a snapshot, and the others stand", async () => {
    const s = await fixture();
    s.grants.hold("time", { tools: ["write_page"] });
    await s.agent.start();
    const snapshot = s.grants.snapshot();
    snapshot.grants.push({ id: 5, kind: "time" }, { ...snapshot.grants[0]!, id: "g-6", kind: "later" }, { ...snapshot.grants[0]!, id: "g-7", status: "later" });
    s.script.reply({ events: [{ type: "CUSTOM", name: "faden.grants", value: snapshot }], text: "Hi." });
    const session = await s.agent.startSession("ask");

    await session.send("Hello.");

    expect(s.agent.grants.live.map((g) => g.id)).toEqual(["g-1"]);
  });

  it("clears the copy and refuses a list with a grant of another agent version", async () => {
    const s = await fixture();
    s.grants.hold("time", { tools: ["write_page"] });
    await s.agent.start();
    await s.agent.grants.refresh();
    expect(s.agent.grants.live).toHaveLength(1);
    s.grants.tamperShown = (g) => { g["agent_version"] = 9; };

    await expect(s.agent.grants.refresh()).rejects.toThrow("another agent version");

    expect(s.agent.grants.live).toEqual([]);
  });

  it.each(["https://evil.test", "https://faden.test:8443", "http://faden.test", "https://faden.test.evil.test", "https://faden.test@evil.test"])(
    "never opens a second sign-in page on another origin (%s)", async (origin) => {
      const s = await fixture();
      s.grants.stepUpOrigin = origin;
      const session = await s.agent.startSession("ask");

      const refused = await session.startBypass().catch((e: unknown) => e);

      expect(refused).toBeInstanceOf(BypassSignInError);
      expect((refused as BypassSignInError).stage).toBe("failed");
      expect(s.card.opened).toEqual([]);
      expect(s.grants.made).toEqual([]);
      expect(s.agent.stepUps.fresh).toBeUndefined();
    });
});

/** A stretch of work's places where they really lead (sdk/38 §6; ASVS 5.0 5.3.2). Port of the .NET GrantPathTests. */
describe("where a stretch of work's places lead", () => {
  const contract = [{ name: "write_page", risk: "write" as const, target_type: "folder", target_argument: "/text" }];

  // A file system in a few lines: the links, by path, to where they lead (null: to nothing). A path is resolved link by link
  // as the operating system does; a name that is not there is kept below the real path of the part that is.
  const links: Record<string, string | null> = { "/srv/granted/link": "/srv/outside", "/srv/granted/project": "/srv/outside", "/srv/granted/dead": null };
  const resolver: GrantPlaceResolver = async (place) => {
    if (!namesPath(place.type) || !isLocalPath(place.identifier)) return place;
    let real = "";
    for (const part of place.identifier.split("/").filter(Boolean)) {
      real += `/${part}`;
      if (Object.hasOwn(links, real)) {
        if (links[real] === null) return null; // where it leads cannot be told
        real = links[real]!;
      }
    }
    return { ...place, identifier: real };
  };

  async function run(folder: string, ...paths: string[]) {
    const s = await fixture({ contract, configure: (b) => b.useGrantPlaceResolver(resolver) });
    const id = s.grants.hold("work", { classes: ["write"], targets: [{ type: "folder", identifiers: [folder] }] });
    paths.forEach((path, i) => s.script.covered(`call-${i}`, "write_page", { page: i, text: path }, id).says("Done."));
    const session = await s.agent.startSession("ask");
    for (const path of paths) await session.send(`Comment on ${path}`);
    return { ...s, session };
  }

  it("asks, and says where it leads, for a junction inside a granted folder that leads outside", async () => {
    const s = await run("/srv/granted", "/srv/granted/plain.txt", "/srv/granted/link/secret.txt", "/srv/granted/link/new.txt", "/srv/granted/link");

    expect([...s.pages.pages.keys()].filter((k) => k < 4)).toEqual([0]); // the others were declined
    expect(s.pages.pages.get(0)).toBe("/srv/granted/plain.txt");
    expect(s.card.asked.map((r) => r.leadsOutside)).toEqual(["/srv/outside/secret.txt", "/srv/outside/new.txt", "/srv/outside"]);
    const records = decisions(s.session);
    expect(records.map((d) => d["scope"])).toEqual(["grant", null, null, null]);
    expect(records.map((d) => d["outside_grant"])).toEqual([false, true, true, true]);
  });

  it("covers what lies in a granted folder reached through a junction", async () => {
    // The person granted the folder by a path that is itself a link: the place and the target lead to the same folder.
    const s = await run("/srv/granted/project", "/srv/granted/project/secret.txt");

    expect(s.card.asked).toEqual([]);
    expect(s.pages.pages.get(0)).toBe("/srv/granted/project/secret.txt");
  });

  it("asks when a link's target is missing, as where it leads cannot be told", async () => {
    const s = await run("/srv/granted", "/srv/granted/dead/new.txt");

    expect(s.card.asked).toHaveLength(1);
    expect(s.card.asked[0]!.leadsOutside).toBeUndefined(); // asked, with the class's own reason
    expect(s.pages.pages.get(0)).toBeUndefined();
  });

  it("does not cover a stretch of work without a resolver", async () => {
    const s = await fixture({ contract });
    const id = s.grants.hold("work", { classes: ["write"], targets: [{ type: "folder", identifiers: ["/srv/granted"] }] });
    s.script.covered("call-0", "write_page", { page: 0, text: "/srv/granted/plain.txt" }, id).says("Done.");
    const session = await s.agent.startSession("ask");

    await session.send("Comment.");

    expect(s.card.asked).toHaveLength(1);
  });

  it("holds what lies under a folder, not a folder whose name starts the same", () => {
    expect(placeLies("folder", "/srv/granted", "/srv/granted/plain.txt")).toBe(true);
    expect(placeLies("folder", "/srv/granted", "/srv/granted/")).toBe(true);
    expect(placeLies("folder", "/srv/granted", "/srv/granted-other/plain.txt")).toBe(false);
    expect(placeLies("document", "/srv/granted", "/srv/granted/plain.txt")).toBe(false); // a document by identity only
    expect(placeLies("folder", "/", "/srv/granted")).toBe(true);
    expect(placeLies("folder", "C:\\Docs", "C:\\Docs\\a.txt")).toBe(true);
    expect(placeLies("folder", "C:\\", "C:\\Docs")).toBe(true);
    expect(placeLies("folder", "C:\\Docs", "C:\\Docs-other\\a.txt")).toBe(false);
    expect(placeLies("folder", "/srv/granted", "/srv/Granted/a.txt")).toBe(false); // a difference of case asks
  });

  it.each([
    ["site", "https://purchase.example.de", "https://Purchase.example.de/orders/7", true],
    ["site", "https://purchase.example.de", "https://purchase.example.de.evil.test/", false],
    ["site", "https://purchase.example.de", "http://purchase.example.de/", false],
    ["document", "https://d.docs.live.net/1/report.docx", "https://d.docs.live.net/1/Report.docx", true],
    ["folder", "/srv/share", "/srv/share/../etc/passwd", false],
    ["folder", "/srv/share", "/srv/share/orders", true],
    ["app", "excel", "EXCEL", true],
  ] as const)("matches a place that names no path here by its text, as the gateway does (%s %s %s)", (type, target, place, lies) => {
    expect(placeNamed(type, target, place)).toBe(lies);
  });

  it("tells a path on a device from a name", () => {
    expect([isLocalPath("/srv/x"), isLocalPath("C:\\x"), isLocalPath("C:/x"), isLocalPath("\\\\server\\share"), isLocalPath("nextcloud:files:2"),
      isLocalPath("https://x/y"), isLocalPath("relative/x")]).toEqual([true, true, true, true, false, false, false]);
  });
});
