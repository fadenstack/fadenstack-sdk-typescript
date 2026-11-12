import { afterEach, describe, expect, it, vi } from "vitest";

import { GrantLifecycle } from "@fadenstack/agents";
import { ApprovalBroker, ApprovalPart, GrantMarkerViewModel, PendingGrant, englishStrings, germanStrings, period, type UiStrings } from "@fadenstack/ui";
import { MIN, REPORT, grantChat } from "./grantsHelpers.js";

/** The device-wide marker over the lifecycle, as .NET's GrantMarkerTests drive it; and `period()`. */
const toDispose: { dispose(): void }[] = [];
afterEach(() => { for (const x of toDispose.splice(0)) x.dispose(); });

async function rig() {
  const s = await grantChat();
  const life = new GrantLifecycle(s.agent.grants, { tickEvery: 0 });
  let strings: UiStrings = englishStrings;
  const stopped: string[] = [];
  const marker = new GrantMarkerViewModel(life, () => strings, {
    chatTitle: (id) => (id === "c-order" ? "Order form" : undefined), stopTurn: (id) => stopped.push(id),
  });
  toDispose.push(life, marker);
  const work = (minutes = 30, conversation = "c-order") => s.agent.grants.grantWork([REPORT], minutes * MIN, conversation);
  const bypass = async (minutes = 60) => {
    const id = s.grants.hold("bypass", { classes: ["read", "write", "destructive", "unknown"] }, minutes);
    await s.agent.grants.refresh();
    return id;
  };
  return { s, life, marker, stopped, work, bypass, language: (next: UiStrings) => { strings = next; marker.retext(); } };
}

describe("period", () => {
  it.each([[0, "0 min"], [1, "1 min"], [59_000, "1 min"], [15 * MIN, "15 min"], [59 * MIN, "59 min"], [60 * MIN, "1 h"], [120 * MIN, "2 h"], [90 * MIN, "1 h 30 min"], [61 * MIN, "1 h 1 min"], [-5, "0 min"]])(
    "says %s ms as %s", (ms, said) => expect(period(englishStrings, ms)).toBe(said));

  it("says hours in hours, never 120 min, in every language", () => {
    expect(period(germanStrings, 120 * MIN)).toBe(germanStrings.durationHours(2));
    expect(period(germanStrings, 90 * MIN)).toBe(germanStrings.durationHoursMinutes(1, 30));
    expect(period(englishStrings, 120 * MIN)).not.toContain("120");
  });
});

describe("the device-wide marker", () => {
  it("shows the time left by the server's clock for work and for Bypass", async () => {
    const r = await rig();
    expect(r.marker.isOn).toBe(false);
    expect(r.marker.markerText).toBe("");
    await r.work(30);
    expect(r.marker).toMatchObject({ isOn: true, markerText: "Working alongside you · 30 min left", badgeText: "30 min" });
    r.s.advance(10 * MIN);
    await r.life.tick();
    expect(r.marker.markerText).toBe("Working alongside you · 20 min left");
    expect(r.marker.entries.map((e) => e.text)).toEqual(["Working alongside you · Order form · 20 min left"]);

    const r2 = await rig();
    await r2.bypass(120);
    expect(r2.marker.markerText).toBe("Bypass on · 2 h left");
  });

  it("counts the grants when there are several, and the lines name each with its chat", async () => {
    const r = await rig();
    await r.work(30, "c-order");
    await r.work(60, "c-other");
    await r.bypass(120);

    expect(r.marker.markerText).toBe("3 grants running · first ends in 30 min");
    expect(r.marker.entries.map((e) => e.text)).toEqual([
      "Working alongside you · Order form · 30 min left",
      "Working alongside you · A chat · 1 h left",
      "Bypass · A chat · 2 h left",
    ]);
  });

  it("stops the turns and every grant and leaves one summary each that says so", async () => {
    const r = await rig();
    await r.work(30, "c-order");
    await r.bypass(60);
    r.s.advance(5 * MIN);

    await r.marker.stop();

    expect(r.stopped).toEqual(["c-order"]);
    expect(r.marker.isOn).toBe(false);
    expect(r.marker.summaries.map((x) => [x.kind, x.title, x.detail])).toEqual([
      ["work", "Worked alongside you for 5 min", "Where: report.docx\nRan without asking: 0\nYou stopped it."],
      ["bypass", "Bypass ran for 5 min", "Ran without asking: 1\nYou stopped it."],
    ]);
    r.marker.dismiss(r.marker.summaries[0]!);
    expect(r.marker.summaries).toHaveLength(1);
  });

  it("says so when the server cannot take Stop, and the marker stays", async () => {
    const r = await rig();
    await r.work(30);
    r.s.grants.revokeOffline = true;

    await r.marker.stop();

    expect(r.marker.isOn).toBe(true);
    expect(r.marker.message).toBe(englishStrings.grantsStopFailed);
    r.marker.dismissMessage();
    expect(r.marker.hasMessage).toBe(false);
  });

  it("offers another 30 min near the end once, and never for Bypass", async () => {
    const r = await rig();
    const grant = await r.work(30);
    const long = await r.bypass(30);
    r.s.advance(28 * MIN);
    await r.life.tick();

    expect(r.marker.isEnding).toBe(true);
    expect(r.marker.entries.map((e) => [e.kind, e.isEnding])).toEqual([["work", true], ["bypass", false]]);
    expect(r.marker.keepGoingText).toBe("Another 30 min");
    await r.marker.keepGoing();
    expect(r.s.agent.grants.find(grant.id)!.remainingS).toBeGreaterThan(30 * 60);
    expect(r.marker.isEnding).toBe(false);
    expect(r.s.agent.grants.find(long)).toBeDefined();
  });

  it("says more time the server refuses in words", async () => {
    const r = await rig();
    await r.work(30);
    r.s.advance(28 * MIN);
    await r.life.tick();
    vi.spyOn(r.s.agent.grants, "extend").mockRejectedValueOnce(Object.assign(new Error("No."), { code: "grant_at_longest" }));
    await r.marker.keepGoing();
    expect(r.marker.message).toBe(englishStrings.grantsAtLongest);

    vi.spyOn(r.s.agent.grants, "extend").mockRejectedValueOnce(new Error("Down."));
    await r.marker.keepGoing();
    expect(r.marker.message).toBe(englishStrings.grantsExtendFailed);
  });

  it("shows a paused grant as paused, and a summary that follows the lock waits until the person is back", async () => {
    const r = await rig();
    await r.work(60);
    await r.life.appEnding();
    expect(r.marker).toMatchObject({ isPaused: true, markerText: "Working alongside you · paused", badgeText: "Paused" });
    expect(r.marker.entries[0]!.text).toBe("Working alongside you · Order form · paused");

    const r2 = await rig();
    await r2.work(60);
    await r2.life.setScreenLock("locked");
    r2.s.advance(GrantLifecycle.LOCKED_FOR);
    await r2.life.tick();
    expect(r2.marker.summaries).toEqual([]); // the person is away
    await r2.life.setScreenLock("unlocked");
    expect(r2.marker.summaries.map((x) => x.reason)).toEqual(["locked"]);
    expect(r2.marker.summaries[0]!.detail).toContain("It ended because the screen stayed locked for 30 minutes.");
  });

  it("says a grant that ended by its time, and the texts follow the language", async () => {
    const r = await rig();
    await r.work(15);
    r.language(germanStrings);
    expect(r.marker.markerText).toBe(germanStrings.markerWorking(germanStrings.durationMinutes(15)));
    expect(r.marker.stopText).toBe(germanStrings.markerStop);
    r.language(englishStrings);

    r.s.advance(15 * MIN);
    await r.life.tick();

    expect(r.marker.summaries.map((x) => [x.title, x.reason])).toEqual([["Worked alongside you for 15 min", "time"]]);
    expect(r.marker.summaries[0]!.detail.endsWith("It ended when its time was up.")).toBe(true);
    expect(r.marker.isOn).toBe(false);
  });
});

describe("the broker as the grant and step-up handler", () => {
  it("declines a grant card and a Bypass confirmation nobody listens for", async () => {
    const broker = new ApprovalBroker();
    const none = new AbortController().signal;
    expect((await broker.requestGrant({ places: [], classes: [], durations: [MIN], preselected: MIN }, none)).allowed).toBe(false);
    const heard = broker.onGrantRequested(() => undefined);
    expect((await broker.requestGrant({ bypass: true, places: [], classes: [], durations: [MIN], preselected: MIN }, none)).allowed).toBe(false); // nobody claimed it
    heard();
  });

  it("opens the second sign-in's page through the host's browser and reports the stages", async () => {
    const broker = new ApprovalBroker();
    const seen: string[] = [];
    broker.onStepUpChanged((_r, stage) => seen.push(stage));
    broker.openBrowser = () => false;
    const request = { link: new URL("https://faden.example/step-up"), userCode: "A", expiresAt: new Date() };
    expect(await broker.open(request)).toBe(false);
    broker.report(request, "browser");
    broker.report(request, "denied");
    expect(seen).toEqual(["browser", "denied"]);
  });

  it("resolves a pending grant once, and rejects with the abort when the wait runs out", async () => {
    const stop = new AbortController();
    const pending = new PendingGrant({ places: [], classes: [], durations: [MIN], preselected: MIN }, stop.signal);
    expect(pending.resolve({ allowed: false, places: [], duration: 0 })).toBe(true);
    expect(pending.resolve({ allowed: true, places: [], duration: MIN })).toBe(false);
    const late = new PendingGrant({ places: [], classes: [], durations: [MIN], preselected: MIN }, stop.signal);
    stop.abort(new Error("Stopped."));
    await expect(late.answer).rejects.toThrow("Stopped.");
  });
});

describe("a call a longer approval let through", () => {
  it("reads 'Allowed by your longer approval'", () => {
    const part = new ApprovalPart({ strings: englishStrings, clipboard: { setText: () => undefined }, locale: undefined, previewLength: 100, now: () => new Date() },
      { callId: "1", toolName: "write_page", toolClass: "write", source: "host", reason: "", arguments: {} }, "approved_by_grant");
    expect(part.stateText).toBe("Allowed by your longer approval");
  });
});
