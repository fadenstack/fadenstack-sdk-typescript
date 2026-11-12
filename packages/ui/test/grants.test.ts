import { describe, expect, it, vi } from "vitest";

import { ApprovalBroker, germanStrings } from "@fadenstack/ui";
import { BUDGET, MIN, REPORT, conversation, grantChat, waitFor, type GrantChat } from "./grantsHelpers.js";

/** The grant cards, markers and Bypass flow in a chat, as .NET's GrantViewModelTests, BypassCardTests and GrantCardConversationTests drive them. */

/** Opens the Bypass card (the mode picker's entry) and waits for it. */
async function ask(s: GrantChat) {
  const done = s.chat.startBypass();
  const card = await waitFor(() => s.chat.grants.bypassCard);
  return { card, done };
}

describe("the work card in a chat", () => {
  it("shows the card in the chat, allow makes the grant, and the marker counts the server's time left", async () => {
    const s = await grantChat();
    const session = await conversation(s);
    const offered = session.offerWork([REPORT, BUDGET]);
    const card = await waitFor(() => s.chat.grants.cards[0]);
    expect(card.conversationId).toBe(session.id);
    card.places[1]!.toggle();
    card.allow();
    const grant = (await offered)!;

    expect(s.grants.made[0]!.json["targets"]).toEqual([{ type: "document", identifiers: ["C:\\Docs\\report.docx"] }]);
    expect(card.state).toBe("allowed");
    expect(s.chat.grants.hasMarker).toBe(true);
    expect(s.chat.grants.markerText).toBe("Working alongside you · 30 min left");
    s.advance(10 * MIN);
    s.chat.grants.tick();
    expect(s.chat.grants.markerText).toBe("Working alongside you · 20 min left");
    expect(s.chat.grants.isEnding).toBe(false);
    expect(grant.kind).toBe("work");
  });

  it("offers more time near the end, once the server allows, and Stop ends every grant and the turn", async () => {
    const s = await grantChat();
    const session = await conversation(s);
    const offered = session.offerWork([REPORT]);
    (await waitFor(() => s.chat.grants.cards[0])).allow();
    await offered;
    s.advance(28 * MIN);
    s.chat.grants.tick();
    expect(s.chat.grants.isEnding).toBe(true);
    expect(s.chat.grants.keepGoingText).toBe("Another 30 min");

    await s.chat.grants.keepGoing();
    expect(s.chat.grants.markerText).toBe("Working alongside you · 32 min left");
    expect(s.chat.grants.isEnding).toBe(false);

    await s.chat.grants.stop();
    expect(s.chat.grants.hasMarker).toBe(false);
    expect(s.agent.grants.live).toEqual([]);
  });

  it("says in words when more time is refused, and when Stop cannot reach the server", async () => {
    const s = await grantChat();
    const session = await conversation(s);
    const offered = session.offerWork([REPORT]);
    (await waitFor(() => s.chat.grants.cards[0])).allow();
    await offered;
    s.advance(28 * MIN);
    s.chat.grants.tick();
    vi.spyOn(s.agent.grants, "extend").mockRejectedValueOnce(Object.assign(new Error("No."), { code: "grant_at_longest" }));
    await s.chat.grants.keepGoing();
    expect(s.chat.grants.message).toBe("This cannot run any longer. To keep going, ask again and answer the card.");

    s.grants.revokeOffline = true;
    await s.chat.grants.stop();
    expect(s.chat.grants.message).toBe(s.chat.strings.grantsStopFailed);
    expect(s.chat.grants.hasMarker).toBe(true);
  });

  it("shows an extension card with only the difference", async () => {
    const s = await grantChat();
    const session = await conversation(s);
    const made = session.offerWork([REPORT]);
    (await waitFor(() => s.chat.grants.cards[0])).allow();
    const grant = (await made)!;

    const extended = session.offerExtension(grant, 30 * MIN);
    const card = await waitFor(() => s.chat.grants.cards[1]);
    expect(card.title).toBe("Keep working alongside you?");
    expect(card.durations.map((d) => d.label)).toEqual(["30 min longer"]);
    card.allow();
    expect(await extended).not.toBeNull();
  });

  it("lists in Settings what was allowed for longer than a call, and Revoke ends it", async () => {
    const s = await grantChat();
    const session = await conversation(s);
    const offered = session.offerWork([REPORT]);
    (await waitFor(() => s.chat.grants.cards[0])).allow();
    await offered;
    await s.chat.grants.load();

    expect(s.chat.grants.standing.map((i) => i.title)).toEqual(["Working alongside you in report.docx, 30 min left"]);
    await s.chat.grants.standing[0]!.revoke();
    expect(s.chat.grants.hasStanding).toBe(false);
    expect(s.chat.grants.standingEmpty).toBe("Nothing is allowed for longer than one call.");
    expect(s.agent.grants.live).toEqual([]);
  });
});

describe("cards and conversations", () => {
  it("shows only the cards offered for a chat's own conversation when chats share a broker", async () => {
    const broker = new ApprovalBroker();
    const a = await grantChat({ broker });
    const b = await grantChat({ broker });
    const sessionA = await conversation(a);
    await conversation(b);

    const offered = sessionA.offerWork([REPORT]);
    await waitFor(() => a.chat.grants.cards[0]);
    expect(b.chat.grants.cards).toEqual([]);
    a.chat.grants.cards[0]!.notNow();
    await offered;
  });

  it("shows a card offered before its conversation existed in every chat", async () => {
    const broker = new ApprovalBroker();
    const a = await grantChat({ broker });
    const b = await grantChat({ broker });
    await conversation(a);
    await conversation(b);

    const answer = broker.requestGrant({ places: [REPORT], classes: ["read"], durations: [30 * MIN], preselected: 30 * MIN }, new AbortController().signal);
    expect([a.chat.grants.cards.length, b.chat.grants.cards.length]).toEqual([1, 1]);
    a.chat.grants.cards[0]!.notNow();
    expect((await answer).allowed).toBe(false);
  });

  it("shows a Bypass confirmation only in the chat of its conversation, and one no chat draws is never allowed", async () => {
    const broker = new ApprovalBroker();
    const a = await grantChat({ broker });
    const b = await grantChat({ broker });
    await conversation(a);
    await conversation(b);

    const answer = await broker.requestGrant({
      bypass: true, places: [], classes: [], durations: [30 * MIN], preselected: 30 * MIN, conversationId: "nobody-has-this",
    }, new AbortController().signal);

    expect(answer.allowed).toBe(false);
    expect([a.chat.grants.bypassCard, b.chat.grants.bypassCard]).toEqual([undefined, undefined]);
  });
});

describe("the Bypass entry, card and marker", () => {
  it("offers the Bypass entry only where the server offers it", async () => {
    const offered = await grantChat();
    expect(offered.chat.toolModes.map((o) => [o.mode, o.available])).toEqual([["off", true], ["read_only", true], ["ask", true], ["auto", true], ["bypass", true]]);
    expect(offered.chat.toolModes.at(-1)).toMatchObject({ label: "Bypass", description: offered.chat.strings.modes.bypass.description });

    const without = await grantChat({ approvals: { standing: null, longest_grant_minutes: 120, grant_classes: ["read", "write"] } });
    expect(without.chat.toolModes.map((o) => o.mode)).not.toContain("bypass");

    const capped = await grantChat({ maxLevel: "auto" });
    expect(capped.chat.toolModes.map((o) => o.mode)).not.toContain("bypass");
  });

  it("shows the confirmation for the picker's entry and never switches on by itself", async () => {
    const s = await grantChat();
    s.chat.selectToolMode("bypass");
    const card = await waitFor(() => s.chat.grants.bypassCard);

    expect(card.isShown).toBe(true);
    expect(card.state).toBe("pending");
    expect(s.chat.toolMode).toBe("ask");
    expect(s.grants.made).toHaveLength(0);
    expect(s.chat.session?.bypass).toBeUndefined();
    card.notNow();
    await waitFor(() => s.chat.session === undefined); // a declined confirmation leaves no conversation
    expect(s.chat.toolMode).toBe("ask");
  });

  it("opens the second sign-in, switches on once the server confirmed, and the marker shows the time and what is recorded", async () => {
    const s = await grantChat();
    const { card, done } = await ask(s);
    card.allow();

    expect(await done).toBe(true);
    expect(s.stages.map(([, stage]) => stage)).toEqual(["browser", "approved"]);
    expect(s.opened).toHaveLength(1);
    expect(card.state).toBe("on");
    expect(s.chat.toolMode).toBe("bypass");
    expect(s.chat.toolModeDescription).toBe(s.chat.strings.modes.bypass.description);
    expect(s.chat.grants.hasBypass).toBe(true);
    expect(s.chat.grants.bypassText).toBe("Bypass on · 30 min left");
    expect(s.chat.grants.bypassRecordedText).toBe("Each tool that runs is recorded with what it was given.");
    expect(s.grants.made[0]!.json["minutes"]).toBe(30);
    s.advance(5 * MIN);
    s.chat.grants.tick();
    expect(s.chat.grants.bypassText).toBe("Bypass on · 25 min left");
  });

  it.each([
    ["denied", "access_denied", "Bypass stays off: it was not approved in the browser."],
    ["timed out", "expired_token", "Bypass stays off: the sign-in in the browser took too long."],
  ])("says so when the person does not approve it in the browser (%s) and nothing is granted", async (_name, outcome, said) => {
    const s = await grantChat();
    s.grants.stepUpOutcome = outcome === "access_denied" ? "denied" : "expired";
    const { card, done } = await ask(s);
    card.allow();

    expect(await done).toBe(false);
    expect(card.stateText).toBe(said);
    expect(s.grants.made).toHaveLength(0);
    expect(s.chat.toolMode).toBe("ask");
    expect(s.chat.grants.hasBypass).toBe(false);
  });

  it("says so when the browser cannot be opened", async () => {
    const s = await grantChat();
    s.broker.openBrowser = () => false;
    const { card, done } = await ask(s);
    card.allow();
    expect(await done).toBe(false);
    expect(card.stateText).toBe("Bypass stays off: the browser could not be opened or the server not reached.");
  });

  it.each([
    ["bypass_not_allowed", 403, "refused"],
    ["grant_limits_unavailable", 503, "unavailable"],
  ])("without the server's acknowledgement (%s) the card says so and the chat stays where it was", async (code, status, key) => {
    const s = await grantChat();
    s.grants.refuse = code;
    s.grants.refuseStatus = status;
    const { card, done } = await ask(s);
    card.allow();

    expect(await done).toBe(false);
    expect(card.state).toBe("not_confirmed");
    expect(card.stateText).toBe(s.chat.strings.bypassNotConfirmed[key as "refused" | "unavailable"]);
    expect(s.chat.toolMode).toBe("ask");
  });

  it("ends with Stop, goes back to the mode it had, and says you ended it with Switch on again", async () => {
    const s = await grantChat();
    const { card, done } = await ask(s);
    card.allow();
    await done;

    await s.chat.grants.stopBypass();
    expect(s.chat.grants.hasBypass).toBe(false);
    await waitFor(() => s.chat.grants.hasBypassEnded && s.chat.grants.bypassEndedText.includes("you ended it"));
    expect(s.chat.grants.bypassEndedText).toBe("Bypass ended: you ended it. Approvals ask again.");
    expect(s.chat.toolMode).toBe("ask");
    expect(s.chat.grants.canSwitchOnAgain).toBe(true);
    expect(s.chat.grants.switchOnAgainText).toBe("Switch on again");

    // Only its click asks again, and it opens the card.
    const again = s.chat.grants.switchOnAgain();
    const second = await waitFor(() => s.chat.grants.bypassCard?.isPending && s.chat.grants.bypassCard);
    expect(s.grants.made).toHaveLength(1);
    second.notNow();
    await again;
  });

  it.each([["admin", "an administrator ended it"], ["kill_switch", "your organisation turned Bypass off"], ["limit", "your organisation narrowed who may use it"]])(
    "when the server ends Bypass (%s) the marker goes and the chat says why", async (by, said) => {
      const s = await grantChat();
      const { card, done } = await ask(s);
      card.allow();
      await done;
      const id = s.agent.grants.live[0]!.id;

      s.grants.end(id, by);
      await s.agent.grants.refresh();
      s.chat.grants.tick();

      await waitFor(() => s.chat.grants.bypassEndedText.includes(said));
      expect(s.chat.grants.hasBypass).toBe(false);
      expect(s.chat.toolMode).toBe("ask");
    });

  it("says its time is up when it runs out", async () => {
    const s = await grantChat();
    const { card, done } = await ask(s);
    card.allow();
    await done;

    s.advance(31 * MIN);
    await s.agent.grants.refresh();
    s.chat.grants.tick();

    await waitFor(() => s.chat.grants.bypassEndedText.includes("its time is up"));
    expect(s.chat.grants.bypassEndedText).toBe(s.chat.strings.bypassEnded.expired);
  });

  it("neither ends nor says it ended when the app's end paused it", async () => {
    const s = await grantChat();
    const { card, done } = await ask(s);
    card.allow();
    await done;

    await s.agent.grants.pauseBypass();
    s.chat.grants.tick();

    expect(s.chat.grants.hasBypassEnded).toBe(false);
    expect(s.chat.toolMode).toBe("bypass");
  });

  it("lists a running Bypass in Settings with what is recorded, and Revoke ends it", async () => {
    const s = await grantChat();
    const { card, done } = await ask(s);
    card.allow();
    await done;
    await s.chat.grants.load();

    expect(s.chat.grants.standing.map((i) => [i.title, i.isBypass])).toEqual([["Bypass in a chat, 30 min left · Each tool that runs is recorded with what it was given.", true]]);
    await s.chat.grants.standing[0]!.revoke();
    expect(s.chat.grants.standing).toEqual([]);
  });

  it("leaving a chat does not end its Bypass: the chat list shows it and the chat comes back in Bypass", async () => {
    const s = await grantChat();
    const { card, done } = await ask(s);
    card.allow();
    await done;
    await s.chat.send("Hi.");
    const id = s.chat.currentSessionId!;
    expect(s.chat.sessions.find((x) => x.id === id)!.bypassText).toBe("Bypass · 30 min left");

    s.chat.newChat();
    expect(s.chat.toolMode).toBe("ask");
    expect(s.chat.grants.hasBypass).toBe(false);
    expect(s.agent.grants.live).toHaveLength(1);
    s.advance(10 * MIN);
    s.chat.grants.tick();
    expect(s.chat.sessions.find((x) => x.id === id)!.bypassText).toBe("Bypass · 20 min left");

    await s.chat.openSession(id);
    expect(s.chat.toolMode).toBe("bypass");
    expect(s.chat.grants.hasBypass).toBe(true);
  });

  it("follows the panel's language", async () => {
    const s = await grantChat();
    const { card, done } = await ask(s);
    expect(card.title).toBe("Switch approvals off in this chat?");
    await s.chat.setLanguage("de");
    expect(card.title).toBe(germanStrings.bypassTitle);
    expect(card.durations[1]!.label).toBe(germanStrings.durationMinutes(30));
    card.notNow();
    await done;
  });
});

describe("the limit on the mode says whose it is", () => {
  it.each([
    ["ask", "ask", "This agent goes no higher than Ask."],
    ["ask", "auto", "Limited to Ask by your organisation."],
  ])("ceiling %s, the agent's highest %s", async (ceiling, max, said) => {
    const s = await grantChat({ maxLevel: "auto", ceiling: "auto" });
    s.chat.selectToolMode("auto");
    expect(s.chat.toolMode).toBe("auto");
    expect(s.chat.toolModeHint).not.toContain("Limited");

    // The organisation lowers the ceiling (and the agent's author its highest level) while the chat is open.
    s.gateway.updateAgent("docs", { ceiling: ceiling as never, maxLevel: max });
    s.advance(2 * MIN);
    await s.agent.refreshProfile();

    expect(s.chat.agent.ceiling).toBe("ask");
    expect(s.chat.toolModeHint.endsWith(said)).toBe(true);
  });
});
