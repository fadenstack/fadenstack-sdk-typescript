import { afterEach, describe, expect, it, vi } from "vitest";

import { GrantLifecycle, GrantPlace, type GrantEnded, type GrantEndingSoon, type GrantLifecycleOptions } from "@fadenstack/agents";

import { fixture, OFFERED, type Fixture } from "./grantHelpers.js";

/**
 * The rules that keep a server-held grant from running on unattended (sdk/46 G2), ported from .NET's
 * `GrantLifecycleTests`: the app's end pauses, the next start resumes under 30 minutes and ends over, the lock pauses and
 * ends after 30 minutes, Stop ends every grant, the end is near once, and the end says why. The server is the fake
 * gateway; time is a fake clock that moves the device's and the server's together.
 */
const MIN = 60_000;
const REPORT = GrantPlace.document("C:\\Docs\\report.docx");
const OFFER = { ...OFFERED, bypass: { ...(OFFERED["bypass"] as object), longest_minutes: 120 } };

let rigs: Rig[] = [];
afterEach(() => { for (const rig of rigs) rig.life.dispose(); rigs = []; });

class Rig {
  now = Date.UTC(2026, 10, 12, 9, 0, 0);
  life!: GrantLifecycle;
  ended: GrantEnded[] = [];
  soon: GrantEndingSoon[] = [];
  constructor(readonly s: Fixture) {
    s.agent.clock = () => this.now;
    s.grants.serverNow = this.now;
    this.life = this.make();
    rigs.push(this);
  }

  static async start(): Promise<Rig> {
    const s = await fixture({ approvals: OFFER, configure: b => b.useGrantPlaceResolver(async place => place) });
    await s.agent.start();
    return new Rig(s);
  }

  /** A lifecycle that ticks only when told, as the app's next run would build one. */
  make(options: GrantLifecycleOptions = {}): GrantLifecycle {
    const life = new GrantLifecycle(this.s.agent.grants, { tickEvery: 0, ...options });
    life.onEnded(e => this.ended.push(e));
    life.onEndingSoon(e => this.soon.push(e));
    return life;
  }

  /** The app ends and starts again: the old lifecycle goes, a new one is built. */
  restart(): void {
    this.life.dispose();
    this.ended = [];
    this.soon = [];
    this.life = this.make();
  }

  advance(ms: number): void {
    this.now += ms;
    this.s.grants.serverNow = this.now;
  }

  work(minutes = 30, conversation = "c-1") {
    return this.s.agent.grants.grantWork([REPORT], minutes * MIN, conversation);
  }

  /** A Bypass the server holds (the step-up is not under test here), read into the copy. */
  async bypass(minutes = 60) {
    const id = this.s.grants.hold("bypass", { classes: ["read", "write", "destructive", "unknown"] }, minutes);
    await this.s.agent.grants.refresh();
    return this.s.agent.grants.live.find(g => g.id === id)!;
  }

  requests(method: string, suffix: string): number {
    return this.s.gateway.requests.filter(r => r.method === method && r.path.endsWith(suffix)).length;
  }

  get revokes(): number { return this.s.gateway.requests.filter(r => r.method === "DELETE").length; }
  get remaining(): number { return this.s.agent.grants.remaining(this.s.agent.grants.live[0]!); }
}

describe("the app's end and the next start", () => {
  it("pauses a running Bypass at the app's end, it does not end it", async () => {
    const rig = await Rig.start();
    const bypass = await rig.bypass(120);

    expect(await rig.life.appEnding()).toBe(1);

    expect(rig.s.grants.status(bypass.id)).toBe("paused");
    expect(rig.revokes).toBe(0);
  });

  it("leaves the grant running at the server when the app's end cannot reach it", async () => {
    const rig = await Rig.start();
    const bypass = await rig.bypass(120);
    rig.s.grants.pauseOffline = true;

    expect(await rig.life.appEnding()).toBe(0);

    expect(rig.s.grants.status(bypass.id)).toBe("active");
    expect(rig.revokes).toBe(0);
  });

  it("resumes a Bypass paused for less than 30 minutes at the next start, with no card", async () => {
    const rig = await Rig.start();
    const bypass = await rig.bypass(120);
    await rig.life.appEnding();
    rig.advance(10 * MIN);
    rig.restart();

    const results = await rig.life.appStarted();

    expect(results.map(r => [r.grant.id, r.outcome])).toEqual([[bypass.id, "resumed"]]);
    expect(rig.s.grants.status(bypass.id)).toBe("active");
    expect(rig.revokes).toBe(0);
    expect(rig.ended).toEqual([]);
    expect(rig.remaining).toBe(110 * MIN);
    expect(rig.s.card.offers).toHaveLength(0);
  });

  it("ends a Bypass paused for 30 minutes or more at the next start and says so", async () => {
    const rig = await Rig.start();
    const bypass = await rig.bypass(120);
    await rig.life.appEnding();
    rig.advance(GrantLifecycle.PAUSED_LIMIT);
    rig.restart();

    const results = await rig.life.appStarted();

    expect(results.map(r => r.outcome)).toEqual(["ended_away"]);
    expect(rig.s.grants.status(bypass.id)).toBe("revoked");
    expect(rig.requests("POST", "/resume")).toBe(0);
    expect(rig.ended.map(e => [e.reason, e.grant.id])).toEqual([["away", bypass.id]]);
  });

  it("ends a work grant paused by the app's end at the next start, and says it worked until then", async () => {
    const rig = await Rig.start();
    const grant = await rig.work(60);
    rig.advance(5 * MIN);
    await rig.life.appEnding();
    rig.advance(GrantLifecycle.PAUSED_LIMIT);
    rig.restart();

    await rig.life.appStarted();

    expect(rig.requests("POST", "/resume")).toBe(0);
    expect(rig.ended.map(e => [e.reason, e.ran])).toEqual([["away", 5 * MIN]]); // it worked until the app ended
    expect(rig.s.grants.status(grant.id)).toBe("revoked");
  });

  it("pauses a running work grant at the app's end and the next start resumes it", async () => {
    const rig = await Rig.start();
    const grant = await rig.work(60);
    await rig.life.appEnding();
    expect(rig.s.grants.status(grant.id)).toBe("paused");
    rig.advance(10 * MIN);
    rig.restart();

    await rig.life.appStarted();

    expect(rig.s.grants.status(grant.id)).toBe("active");
    expect(rig.remaining).toBe(50 * MIN);
  });

  it.each([["admin", "admin"], ["kill_switch", "kill_switch"], ["limit", "limit"]])(
    "says why from the server's word when it refuses the resume (%s)", async (by, expected) => {
      const rig = await Rig.start();
      const bypass = await rig.bypass(120);
      await rig.life.appEnding();
      rig.restart();
      // The server ends it as it refuses, and names who.
      rig.s.grants.refuseResume = 403;
      rig.s.grants.resumeEndsBy = by;

      const results = await rig.life.appStarted();

      expect(results.map(r => r.outcome)).toEqual(["refused"]);
      await vi.waitFor(() => expect(rig.ended).toHaveLength(1));
      expect(rig.ended[0]!.reason).toBe(expected);
      expect(rig.s.agent.grants.live).toEqual([]);
    });

  it("says the server ended it when the server cannot say why", async () => {
    const rig = await Rig.start();
    const bypass = await rig.bypass(120);
    await rig.life.appEnding();
    rig.restart();
    rig.s.grants.canSayWhy = false;
    rig.s.grants.refuseResume = 403;

    await rig.life.appStarted();

    await vi.waitFor(() => expect(rig.ended).toHaveLength(1));
    expect(rig.ended[0]!.reason).toBe("elsewhere");
    expect(bypass.id).toBeTruthy();
  });

  it("keeps a grant paused when the server cannot check, and tries it at every tick", async () => {
    const rig = await Rig.start();
    const bypass = await rig.bypass(120);
    await rig.life.appEnding();
    rig.restart();
    rig.s.grants.refuseResume = 503;

    const results = await rig.life.appStarted();

    expect(results.map(r => r.outcome)).toEqual(["unavailable"]);
    expect(rig.life.waiting).toBe(1);
    expect(rig.s.grants.status(bypass.id)).toBe("paused");
    await rig.life.tick();
    await rig.life.tick();
    expect(rig.requests("POST", "/resume")).toBe(3); // the start and two ticks

    rig.s.grants.refuseResume = undefined; // the server can check now
    await rig.life.tick();

    expect(rig.s.grants.status(bypass.id)).toBe("active");
    expect(rig.life.waiting).toBe(0);
    await rig.life.tick();
    expect(rig.requests("POST", "/resume")).toBe(4); // no more tries once it runs
  });

  it("leaves a grant found running at the start running", async () => {
    const rig = await Rig.start();
    const bypass = await rig.bypass(120);
    rig.restart();

    const results = await rig.life.appStarted();

    expect(results).toEqual([]);
    expect(rig.s.grants.status(bypass.id)).toBe("active");
    expect([rig.revokes, rig.requests("POST", "/pause"), rig.requests("POST", "/resume")]).toEqual([0, 0, 0]);
  });

  it("started with the screen locked, resumes a paused grant with the unlock", async () => {
    const rig = await Rig.start();
    const grant = await rig.work(60);
    await rig.life.appEnding();
    rig.restart();
    await rig.life.setScreenLock("locked");

    const results = await rig.life.appStarted();

    expect(results.map(r => r.outcome)).toEqual(["waits_for_unlock"]);
    expect(rig.requests("POST", "/resume")).toBe(0);
    await rig.life.setScreenLock("unlocked");
    expect(rig.s.grants.status(grant.id)).toBe("active");
  });
});

describe("Stop", () => {
  it("ends every grant of the device, a paused one too, and says stopped without asking the server", async () => {
    const rig = await Rig.start();
    const first = await rig.work(30, "c-1");
    const second = await rig.work(30, "c-2");
    const bypass = await rig.bypass(60);
    await rig.s.agent.grants.pause(second.id);
    rig.advance(5 * MIN);

    const result = await rig.life.stop();

    expect(result).toEqual({ grants: 3, ended: 3, complete: true });
    for (const id of [first.id, second.id, bypass.id]) expect(rig.s.grants.status(id)).toBe("revoked");
    expect(rig.s.agent.grants.live).toEqual([]);
    expect(rig.ended.map(e => e.reason)).toEqual(["stopped", "stopped", "stopped"]);
    expect(rig.ended.find(e => e.grant.id === first.id)!.ran).toBe(5 * MIN);
    expect(rig.s.gateway.requests.filter(r => r.method === "GET" && /\/grants\/g-/.test(r.path))).toHaveLength(0);
  });

  it("still ends the rest when one grant already ended at the server", async () => {
    const rig = await Rig.start();
    const first = await rig.work(30, "c-1");
    const second = await rig.work(30, "c-2");
    rig.s.gateway.requests.length = 0;
    const real = rig.s.agent.grants.revoke.bind(rig.s.agent.grants);
    rig.s.agent.grants.revoke = async (id, signal) => {
      if (id === first.id) throw Object.assign(new Error("You have no such grant."), { status: 404 });
      return real(id, signal);
    };

    const result = await rig.life.stop();

    expect(result.complete).toBe(true);
    expect(rig.s.grants.status(second.id)).toBe("revoked");
  });

  it("drops a grant the server already ended from the running list at once", async () => {
    const rig = await Rig.start();
    const first = await rig.work(30, "c-1");
    const second = await rig.work(30, "c-2");
    rig.s.grants.end(first.id, "person");
    const real = rig.s.agent.grants.revoke.bind(rig.s.agent.grants);
    rig.s.agent.grants.revoke = async (id, signal) => {
      if (id === first.id) throw Object.assign(new Error("You have no such grant."), { status: 404 });
      return real(id, signal);
    };

    await rig.life.stop();

    // The device's copy reads the server's list again: no marker shows it until the next look (.NET 46062f5).
    expect(rig.life.running.map(g => g.id)).not.toContain(first.id);
    expect(rig.life.running.map(g => g.id)).not.toContain(second.id);
  });

  it("says so when the server cannot take the stop, and ends nothing said", async () => {
    const rig = await Rig.start();
    const grant = await rig.work(30);
    rig.s.grants.revokeOffline = true;

    const result = await rig.life.stop();

    expect(result).toEqual({ grants: 1, ended: 0, complete: false });
    expect(rig.s.grants.status(grant.id)).toBe("active");
    expect(rig.ended).toEqual([]);
    expect(rig.life.running).toHaveLength(1);
  });
});

describe("near the end, and the end", () => {
  it("says two minutes before the end, once, and again only after more time was added", async () => {
    const rig = await Rig.start();
    const grant = await rig.work(30);
    rig.advance(27 * MIN);
    await rig.life.tick();
    expect(rig.soon).toEqual([]);

    rig.advance(MIN); // two minutes left
    await rig.life.tick();
    expect(rig.soon.map(s => [s.grant.id, s.left])).toEqual([[grant.id, 2 * MIN]]);

    rig.advance(30_000);
    await rig.life.tick();
    await rig.life.tick();
    expect(rig.soon).toHaveLength(1); // once per end time

    const longer = await rig.life.keepGoing(grant.id);
    expect(rig.s.agent.grants.remaining(longer)).toBe(31.5 * MIN);
    await rig.life.tick();
    expect(rig.soon).toHaveLength(1);
    rig.advance(30 * MIN);
    await rig.life.tick();
    expect(rig.soon).toHaveLength(2); // the new end time asks once more
  });

  it("never offers Bypass more time", async () => {
    const rig = await Rig.start();
    const bypass = await rig.bypass(30);
    rig.advance(29 * MIN);

    await rig.life.tick();

    expect(rig.soon).toEqual([]);
    await expect(rig.life.keepGoing(bypass.id)).rejects.toThrow(/not extended/);
  });

  it("ends at its time with one event and no revoke", async () => {
    const rig = await Rig.start();
    const grant = await rig.work(15);

    rig.advance(15 * MIN);
    await rig.life.tick();
    await rig.life.tick();

    expect(rig.ended.map(e => [e.grant.id, e.reason, e.ran])).toEqual([[grant.id, "time", 15 * MIN]]);
    expect(rig.revokes).toBe(0);
  });

  it.each([["person", "stopped"], ["admin", "admin"], ["kill_switch", "kill_switch"], ["limit", "limit"]])(
    "says why a grant the server ended ended, by its word, at the next read of its list (%s)", async (by, expected) => {
      const rig = await Rig.start();
      const grant = await rig.work(30);
      rig.s.grants.end(grant.id, by);
      await rig.life.tick();
      expect(rig.ended).toEqual([]); // the copy has not read the list yet

      rig.advance(GrantLifecycle.REFRESH_EVERY);
      await rig.life.tick();

      await vi.waitFor(() => expect(rig.ended).toHaveLength(1));
      expect(rig.ended[0]!.reason).toBe(expected);
      expect(rig.life.running).toEqual([]);
    });

  it("says the server ended it when the server cannot say why", async () => {
    const rig = await Rig.start();
    const grant = await rig.work(30);
    rig.s.grants.end(grant.id, "admin");
    rig.s.grants.canSayWhy = false; // offline, an older server

    rig.advance(GrantLifecycle.REFRESH_EVERY);
    await rig.life.tick();

    await vi.waitFor(() => expect(rig.ended).toHaveLength(1));
    expect(rig.ended[0]!.reason).toBe("elsewhere");
  });
});

describe("the lock", () => {
  it("pauses a work grant when the screen locks and resumes it with the unlock", async () => {
    const rig = await Rig.start();
    const grant = await rig.work(30);

    await rig.life.setScreenLock("locked");
    expect(rig.s.grants.status(grant.id)).toBe("paused");
    expect(rig.life.isLocked).toBe(true);

    rig.advance(10 * MIN); // its clock runs on while paused
    await rig.life.setScreenLock("unlocked");

    expect(rig.s.grants.status(grant.id)).toBe("active");
    expect(rig.life.isLocked).toBe(false);
    expect(rig.remaining).toBe(20 * MIN);
  });

  it("ends a work grant locked for 30 minutes, and unlocking does not resume it", async () => {
    const rig = await Rig.start();
    const grant = await rig.work(60);
    await rig.life.setScreenLock("locked");

    rig.advance(GrantLifecycle.LOCKED_FOR - 1000);
    await rig.life.tick();
    expect(rig.ended).toEqual([]);

    rig.advance(1000);
    await rig.life.tick();

    expect(rig.s.grants.status(grant.id)).toBe("revoked");
    expect(rig.ended.map(e => [e.reason, e.ran])).toEqual([["locked", 30 * MIN]]);
    expect(rig.life.isLocked).toBe(true); // the host holds the summary until the person is back
    await rig.life.setScreenLock("unlocked");
    expect(rig.requests("POST", "/resume")).toBe(0);
  });

  it("ends at the unlock what the lock ended but could not tell the server", async () => {
    const rig = await Rig.start();
    const grant = await rig.work(60);
    await rig.life.setScreenLock("locked");
    rig.s.grants.revokeOffline = true;
    rig.advance(GrantLifecycle.LOCKED_FOR);
    await rig.life.tick();
    expect(rig.s.grants.status(grant.id)).toBe("paused");
    expect(rig.ended).toEqual([]);

    rig.s.grants.revokeOffline = false;
    await rig.life.setScreenLock("unlocked");

    expect(rig.s.grants.status(grant.id)).toBe("revoked");
    expect(rig.ended.map(e => e.reason)).toEqual(["locked"]);
  });

  it("keeps the grant paused when the lock can no longer be read, until the screen reads unlocked", async () => {
    const rig = await Rig.start();
    const grant = await rig.work(60);
    await rig.life.setScreenLock("locked");

    await rig.life.setScreenLock("unknown"); // the bus went while the person is away

    expect(rig.life.isLocked).toBe(true);
    expect(rig.s.grants.status(grant.id)).toBe("paused");
    expect(rig.requests("POST", "/resume")).toBe(0);
    await rig.life.setScreenLock("unlocked");
    expect(rig.s.grants.status(grant.id)).toBe("active");
  });

  it("never pauses and never ends on a lock state it cannot read", async () => {
    const rig = await Rig.start();
    const grant = await rig.work(60);

    await rig.life.setScreenLock("unknown");
    rig.advance(GrantLifecycle.LOCKED_FOR);
    await rig.life.tick();

    expect(rig.requests("POST", "/pause")).toBe(0);
    expect(rig.s.grants.status(grant.id)).toBe("active");
    expect(rig.ended).toEqual([]);
  });

  it("pauses and ends a stretch of work at the lock but leaves Bypass to the app's end", async () => {
    const rig = await Rig.start();
    const work = await rig.work(120);
    const bypass = await rig.bypass(120);

    await rig.life.setScreenLock("locked");
    expect([rig.s.grants.status(work.id), rig.s.grants.status(bypass.id)]).toEqual(["paused", "active"]);

    rig.advance(GrantLifecycle.LOCKED_FOR);
    await rig.life.tick();

    expect([rig.s.grants.status(work.id), rig.s.grants.status(bypass.id)]).toEqual(["revoked", "active"]);
    expect(rig.ended.map(e => e.reason)).toEqual(["locked"]);
  });

  it("looks after what the host adds to the options too", async () => {
    const rig = await Rig.start();
    const id = rig.s.grants.hold("time", { tools: ["add_comment"] }, 30);
    await rig.s.agent.grants.refresh();
    const life = rig.make({ manages: g => g.kind === "time", pausedByLock: g => g.kind === "time" });

    await life.setScreenLock("locked");

    expect(rig.s.grants.status(id)).toBe("paused");
    expect(life.running.map(g => g.id)).toEqual([id]);
    life.dispose();
  });
});
