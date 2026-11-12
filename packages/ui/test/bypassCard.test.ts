import { describe, expect, it } from "vitest";

import { BypassSignInError, GrantAnswer, type GrantOffer, type StepUpRequest } from "@fadenstack/agents";
import { FadenstackApiError, FadenstackPermissionError, FadenstackUnreachableError } from "@fadenstack/client";
import { BypassPart, GrantPart, PendingGrant, englishStrings, germanStrings, type PartContext } from "@fadenstack/ui";

/** The Bypass card and the grant card on their own, as .NET's BypassCardTests and GrantViewModelTests drive them. */
const MIN = 60_000;
const context = (strings = englishStrings): PartContext => ({ strings, clipboard: { setText: () => undefined }, locale: undefined, previewLength: 4000, now: () => new Date() });
const bypassOffer = (over: Partial<GrantOffer> = {}): GrantOffer => ({
  bypass: true, places: [], classes: [], durations: [15 * MIN, 30 * MIN, 60 * MIN], preselected: 30 * MIN, evidence: "calls", conversationId: "c-1", ...over,
});
const request: StepUpRequest = { link: new URL("https://faden.example/step-up#code=ABCD-EFGH"), userCode: "ABCD-EFGH", expiresAt: new Date(Date.now() + 600_000), conversationId: "c-1" };

function bypass(over: Partial<GrantOffer> = {}, strings = englishStrings) {
  const ctx = context(strings);
  const pending = new PendingGrant(bypassOffer(over), new AbortController().signal);
  const opened: URL[] = [];
  const card = new BypassPart(ctx, pending, (link) => { opened.push(link); return true; });
  return { card, pending, opened, ctx, answer: pending.answer };
}

describe("the Bypass card", () => {
  it.each([
    ["decisions", "Your organisation's server records each tool that runs without asking: which tool, when and where, but not what it was given."],
    ["calls", englishStrings.bypassRecords.calls],
    ["results", englishStrings.bypassRecords.results],
    [undefined, englishStrings.bypassRecords.calls],
  ])("says what no longer asks, what still asks, what the server records (%s) and for how long", (evidence, records) => {
    const { card } = bypass({ evidence: evidence as string });
    expect(card.title).toBe("Switch approvals off in this chat?");
    expect(card.noLongerAsksText).toBe(englishStrings.bypassNoLongerAsks);
    expect(card.stillAsksText).toBe(englishStrings.bypassStillAsks);
    expect(card.recordsText).toBe(records);
    expect(card.durations.map((d) => d.label)).toEqual(["15 min", "30 min", "1 h"]); // the shortest first, "1 h" and not "60 min"
    expect(card.selectedDuration).toBe(30 * MIN);
    expect(card.noExtensionText).toBe(englishStrings.bypassNoExtension);
    expect(card.shownText).toContain(records);
  });

  it("puts Not now first, focuses it, and never lets Allow be the default or Enter and Escape answer", () => {
    const { card } = bypass();
    expect(card.buttons).toEqual(["notNow", "allow"]);
    expect(card.initialFocus).toBe("notNow");
    expect(card.ignoresKey("Enter")).toBe(true);
    expect(card.ignoresKey("Escape")).toBe(true);
    expect(card.ignoresKey("a")).toBe(false);
    expect(card.isPending).toBe(true); // nothing answered it
  });

  it("is answered once, by the click, and keeps a reason of at most 500 characters cut at a character's end", async () => {
    const { card, answer } = bypass();
    const emoji = "\u{1F600}";
    card.reason = "x".repeat(499) + emoji + "more";
    expect(card.reasonLength).toBe(500);
    expect(card.reason).toHaveLength(499);
    expect(/[\ud800-\udfff]/.test(card.reason)).toBe(false);
    card.reason = "  Needed for the audit.  ";
    card.selectDuration(15 * MIN);
    card.selectDuration(7 * MIN); // not among the offer's
    card.allow();
    card.allow();
    card.notNow(); // too late

    expect(await answer).toMatchObject({ allowed: true, duration: 15 * MIN, reason: "Needed for the audit." });
    expect(card.state).toBe("confirming");
    card.reason = "changed"; // not once it is answered
    card.selectDuration(60 * MIN);
    expect([card.reason, card.selectedDuration]).toEqual(["  Needed for the audit.  ".slice(0, 25), 15 * MIN]);
  });

  it("goes from pending to confirming to signing in, shows the code, and is on once confirmed", async () => {
    const { card, opened } = bypass();
    card.allow();
    expect(card.state).toBe("confirming");
    expect(card.stateText).toBe(englishStrings.bypassConfirming);

    card.stepUp(request, "browser");
    expect(card.isSigningIn).toBe(true);
    expect(card.signInText).toBe(englishStrings.bypassSignIn);
    expect(card.signInCodeText).toBe("The page shows the code ABCD-EFGH.");
    expect(card.openAgainText).toBe("Open the page again");
    card.openAgain();
    expect(opened.map((l) => l.href)).toEqual([request.link.href]);

    card.stepUp(request, "approved");
    expect(card.state).toBe("confirming");
    expect(card.canOpenAgain).toBe(false);
    card.confirmed();
    expect(card.state).toBe("on");
    expect(card.stateText).toBe("Bypass is on");
    expect(card.isShown).toBe(false);
  });

  it.each([
    ["denied", "Bypass stays off: it was not approved in the browser."],
    ["timed_out", "Bypass stays off: the sign-in in the browser took too long."],
    ["failed", "Bypass stays off: the browser could not be opened or the server not reached."],
  ] as const)("ends the card with its own text when the sign-in comes to nothing (%s), reported or thrown", (stage, said) => {
    const reported = bypass();
    reported.card.allow();
    reported.card.stepUp(request, stage);
    expect(reported.card.state).toBe("not_confirmed");
    expect(reported.card.stateText).toBe(said);
    expect(reported.card.isShown).toBe(true);
    reported.card.close();
    expect(reported.card.isShown).toBe(false);

    const thrown = bypass();
    thrown.card.allow();
    thrown.card.notConfirmed(new BypassSignInError(stage, "No."));
    expect(thrown.card.stateText).toBe(said);
  });

  it("withdraws when the app stopped waiting for the sign-in, and ignores a report for a card nobody allowed", () => {
    const waiting = bypass();
    waiting.card.allow();
    waiting.card.stepUp(request, "browser");
    waiting.card.stepUp(request, "cancelled");
    expect(waiting.card.state).toBe("declined");

    const idle = bypass();
    idle.card.stepUp(request, "browser");
    idle.card.stepUp(request, "denied");
    expect(idle.card.state).toBe("pending");
    idle.card.notNow();
    expect(idle.card.state).toBe("declined");
    expect(idle.card.stateText).toBe("Not now");
  });

  it.each([
    [new FadenstackApiError(403, "No.", { code: "bypass_not_allowed" }), "Bypass is not on: your organisation does not allow it for this agent now. Approvals ask as before."],
    [new FadenstackApiError(403, "No.", { code: "grant_not_offered" }), englishStrings.bypassNotConfirmed.refused],
    [new FadenstackPermissionError(403, "No."), englishStrings.bypassNotConfirmed.refused],
    [new FadenstackApiError(503, "Later.", { code: "grant_limits_unavailable" }), "Bypass is not on: the server cannot check its limits right now. Approvals ask as before."],
    [new FadenstackUnreachableError("Down."), "Bypass is not on: the server could not be reached. Approvals ask as before."],
    [new TypeError("fetch failed"), englishStrings.bypassNotConfirmed.offline],
    [new FadenstackApiError(500, "Odd.", { code: "odd" }), "Bypass is not on: the server did not confirm it. Approvals ask as before."],
    [new Error("Other."), englishStrings.bypassNotConfirmedUnknown],
  ])("says why the server gave no acknowledgement (%#)", (error, said) => {
    const { card } = bypass();
    card.allow();
    card.notConfirmed(error);
    expect(card.state).toBe("not_confirmed");
    expect(card.stateText).toBe(said);
  });

  it("follows the panel's language", () => {
    const { card, ctx } = bypass();
    expect(card.allowText).toBe("Switch Bypass on");
    let changes = 0;
    card.subscribe(() => changes++);
    ctx.strings = germanStrings;
    card.retext();
    expect(changes).toBe(1);
    expect(card.title).toBe(germanStrings.bypassTitle);
    expect(card.durations[2]!.label).toBe(germanStrings.durationHours(1));
    expect(card.allowText).toBe(germanStrings.bypassAllow);
  });
});

describe("the grant card", () => {
  const places = [{ type: "document" as const, identifier: "C:\\Docs\\report.docx", label: "report.docx" }, { type: "folder" as const, identifier: "C:\\Docs", label: "Docs" }];
  const workOffer = (over: Partial<GrantOffer> = {}): GrantOffer => ({
    places, classes: ["read", "write"], durations: [15 * MIN, 30 * MIN, 60 * MIN, 120 * MIN], preselected: 30 * MIN, conversationId: "c-1", ...over,
  });
  const card = (offer: GrantOffer = workOffer()) => {
    const pending = new PendingGrant(offer, new AbortController().signal);
    return { card: new GrantPart(context(), pending), pending, answer: pending.answer };
  };

  it("offers its times in hours where they are, lists the places, and allow sends what was kept", async () => {
    const { card: c, answer } = card();
    expect(c.title).toBe("Work alongside you?");
    expect(c.durations.map((d) => d.label)).toEqual(["15 min", "30 min", "1 h", "2 h"]);
    expect(c.selectedDuration).toBe(30 * MIN);
    expect(c.mayText).toBe("Without asking I may read, write and change things there.");
    expect(c.stillAsksText).toBe(englishStrings.grantStillAsks);
    expect(c.buttons).toEqual(["notNow", "allow"]);
    c.places[1]!.toggle();
    c.selectDuration(2 * 60 * MIN);
    expect(c.shownText).toContain("2 h");
    expect(c.shownText).toContain("I'll work in: report.docx");
    c.allow();

    const given = await answer;
    expect(given).toMatchObject({ allowed: true, duration: 120 * MIN });
    expect(given.places.map((p) => p.label)).toEqual(["report.docx"]);
    expect(c.state).toBe("allowed");
    expect(c.stateText).toBe("Working alongside you");
  });

  it("makes no grant for Not now, and a card with every place taken out cannot be allowed", async () => {
    const declined = card();
    declined.card.notNow();
    expect(await declined.answer).toEqual(GrantAnswer.notNow);
    expect(declined.card.stateText).toBe("Not now");
    declined.card.places[0]!.toggle(); // answered: the places no longer change
    expect(declined.card.places[0]!.kept).toBe(true);

    const empty = card();
    for (const place of empty.card.places) place.toggle();
    expect(empty.card.canAllow).toBe(false);
    empty.card.allow();
    expect(empty.card.isPending).toBe(true);
  });

  it("extends: shows only the difference, as how much longer", () => {
    const { card: c } = card(workOffer({ places: [], durations: [30 * MIN], preselected: 30 * MIN, extending: { id: "g-1" } as never }));
    expect(c.isExtension).toBe(true);
    expect(c.title).toBe("Keep working alongside you?");
    expect(c.durations.map((d) => d.label)).toEqual(["30 min longer"]);
    expect(c.canAllow).toBe(true); // an extension needs no place
  });

  it("is declined when the wait runs out", () => {
    const controller = new AbortController();
    const pending = new PendingGrant(workOffer(), controller.signal);
    const c = new GrantPart(context(), pending);
    controller.abort();
    expect(c.state).toBe("declined");
  });
});
