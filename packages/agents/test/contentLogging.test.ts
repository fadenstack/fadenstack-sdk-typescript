import { describe, expect, it } from "vitest";

import { ContentLoggingError, MachinePolicy, type AgentBuilder, type AgentHooks } from "@fadenstack/agents";
import type { FadenstackLogger, LogEvent } from "@fadenstack/client";

import { setup } from "./helpers.js";

// Time-limited content logging (8.1, OWASP ASVS 5.0 V16): off by default even where the app offered it, the person's start switches it on for
// a set time, it ends at its time, and the hooks follow the state at each call. The same cases as .NET's ContentLoggingTests.

const T1 = "MARBLE-TURN-ONE-81", T2 = "MARBLE-TURN-TWO-82", T3 = "MARBLE-TURN-THREE-83";
const HOUR = 60 * 60 * 1000, MINUTE = 60 * 1000;

/** A clock the test moves, and the timers it fires by hand. */
class Rig {
  now = Date.UTC(2026, 10, 16, 12, 0, 0);
  readonly timers: { ms: number; run: () => void; stopped: boolean }[] = [];
  readonly schedule = (ms: number, run: () => void) => {
    const timer = { ms, run, stopped: false };
    this.timers.push(timer);
    return () => { timer.stopped = true; };
  };
  use(builder: AgentBuilder): AgentBuilder {
    return builder.useContentLoggingTimers(() => this.now, this.schedule);
  }
}

class Capture implements FadenstackLogger {
  readonly events: LogEvent[] = [];
  log(event: LogEvent): void { this.events.push(event); }
  ofId(id: number) { return this.events.filter((e) => e.eventId === id); }
  get text() { return JSON.stringify(this.events); }
}

const offered = (rig: Rig, ...more: ((b: AgentBuilder) => AgentBuilder)[]) => (b: AgentBuilder) =>
  more.reduce((acc, f) => f(acc), rig.use(b.useHookContent()));

describe("content logging", () => {
  it("is off until the person starts it, even where the app offered it at build time", async () => {
    const s = await setup({}, undefined, offered(new Rig()));
    expect(s.agent.contentLogging.offered).toBe(true);
    expect(s.agent.contentLogging.canStart).toBe(true);
    expect(s.agent.contentLogging.isOn).toBe(false);
    expect(s.agent.contentLogging.until).toBeUndefined();
  });

  it("starts and stops, says so, and ends its timer", async () => {
    const rig = new Rig();
    const s = await setup({}, undefined, offered(rig));
    let changes = 0;
    s.agent.contentLogging.onChanged(() => changes++);

    s.agent.startContentLogging(4 * HOUR);
    expect(s.agent.contentLogging.isOn).toBe(true);
    expect(s.agent.contentLogging.until).toBe(rig.now + 4 * HOUR);
    expect(changes).toBe(1);
    expect(rig.timers).toHaveLength(1);
    expect(rig.timers[0]!.ms).toBe(4 * HOUR);

    s.agent.stopContentLogging();
    expect(s.agent.contentLogging.isOn).toBe(false);
    expect(s.agent.contentLogging.until).toBeUndefined();
    expect(changes).toBe(2);
    expect(rig.timers[0]!.stopped).toBe(true);

    s.agent.stopContentLogging(); // off already: nothing happens
    expect(changes).toBe(2);
  });

  it("ends at until by the clock even when the timer never fired", async () => {
    const rig = new Rig();
    const s = await setup({}, undefined, offered(rig));
    let changes = 0;
    s.agent.contentLogging.onChanged(() => changes++);
    s.agent.startContentLogging(15 * MINUTE);

    rig.now += 14 * MINUTE;
    expect(s.agent.contentLogging.isOn).toBe(true);
    rig.now += MINUTE; // the machine slept: no timer fired, the clock says it is over
    expect(s.agent.contentLogging.isOn).toBe(false);
    expect(s.agent.contentLogging.until).toBeUndefined();
    expect(changes).toBe(2);
  });

  it("is ended by the timer, which says so; a timer that fires early waits again", async () => {
    const rig = new Rig();
    const s = await setup({}, undefined, offered(rig));
    let changes = 0;
    s.agent.contentLogging.onChanged(() => changes++);
    s.agent.startContentLogging(HOUR);

    rig.now += 59 * MINUTE;
    rig.timers[0]!.run();
    expect(rig.timers).toHaveLength(2);
    expect(rig.timers[1]!.ms).toBe(MINUTE);
    expect(s.agent.contentLogging.isOn).toBe(true);

    rig.now += MINUTE;
    rig.timers[1]!.run();
    expect(changes).toBe(2);
    expect(s.agent.contentLogging.isOn).toBe(false);
  });

  it("is not kept across restarts: a new agent starts off", async () => {
    const rig = new Rig();
    const first = await setup({}, undefined, offered(rig));
    first.agent.startContentLogging(24 * HOUR);
    const second = await setup({}, undefined, offered(rig));
    expect(second.agent.contentLogging.isOn).toBe(false);
  });

  it("is refused when the app did not offer it", async () => {
    const s = await setup();
    expect(() => s.agent.startContentLogging(HOUR)).toThrow(ContentLoggingError);
    try { s.agent.startContentLogging(HOUR); } catch (e) { expect((e as ContentLoggingError).reason).toBe("notOffered"); }
    expect(s.agent.contentLogging.offered).toBe(false);
    expect(s.agent.contentLogging.canStart).toBe(false);
    expect(s.agent.contentLogging.isOn).toBe(false);
  });

  it.each(['{"contentLogging":"forbidden"}', '{"contentLogging":"nonsense"}'])("is refused when the machine policy forbids it (%s)", async (policy) => {
    const s = await setup({}, undefined, (b) => b.useHookContent().useMachinePolicy(MachinePolicy.fromJson(policy)));
    let reason: string | undefined;
    try { s.agent.startContentLogging(HOUR); } catch (e) { reason = (e as ContentLoggingError).reason; }
    expect(reason).toBe("forbiddenByPolicy");
    expect(s.agent.contentLogging.offered).toBe(true);
    expect(s.agent.contentLogging.canStart).toBe(false);
    expect(s.agent.contentLogging.isOn).toBe(false);
  });

  it("is refused when the policy could not be read", async () => {
    const s = await setup({}, undefined, (b) => b.useHookContent().useMachinePolicy(MachinePolicy.unreadable));
    expect(() => s.agent.startContentLogging(HOUR)).toThrow(ContentLoggingError);
  });

  it.each([14 * MINUTE, 24 * HOUR + 1, 0, Number.NaN])("takes fifteen minutes to twenty four hours (%s ms is refused)", async (ms) => {
    const s = await setup({}, undefined, offered(new Rig()));
    expect(() => s.agent.startContentLogging(ms)).toThrow(RangeError);
    expect(s.agent.contentLogging.isOn).toBe(false);
    s.agent.startContentLogging(15 * MINUTE);
    s.agent.startContentLogging(24 * HOUR);
  });

  it("lets hooks see message text only while it is on", async () => {
    const rig = new Rig();
    const sawMessages: boolean[] = [], sawText: boolean[] = [];
    const hooks: AgentHooks = {
      beforeModelCall: (c) => { sawMessages.push(c.messages !== undefined); },
      afterModelCall: (r) => { sawText.push(r.text !== undefined); },
    };
    const s = await setup({ agents: [{ slug: "docs", contract: [] }], model: () => ({ text: "answer" }) }, undefined, offered(rig, (b) => b.addHooks(hooks)));
    const session = await s.agent.startSession("auto");

    await session.send(T1);
    s.agent.startContentLogging(HOUR);
    await session.send(T2);
    rig.now += HOUR; // its time is up
    await session.send(T3);

    expect(sawMessages).toEqual([false, true, false]);
    expect(sawText).toEqual([false, true, false]);
  });

  it("logs each start and stop with its end time and no content", async () => {
    const rig = new Rig();
    const log = new Capture();
    const s = await setup({ agents: [{ slug: "docs", contract: [] }], model: () => ({ text: "answer" }) }, undefined, offered(rig, (b) => b.useLogging(log)));
    const session = await s.agent.startSession("auto");

    s.agent.startContentLogging(HOUR);
    await session.send(T2);
    s.agent.stopContentLogging();

    const started = log.ofId(2083);
    const stopped = log.ofId(2084);
    expect(started.map((e) => e.message)).toEqual(["Agent docs: content logging was switched on for 60 minutes, until 2026-11-16T13:00:00.000Z"]);
    expect(stopped.map((e) => e.message)).toEqual(["Agent docs: content logging is off (stopped); it was set to end at 2026-11-16T13:00:00.000Z"]);
    expect(started[0]).toMatchObject({ level: "information", category: "Fadenstack.Agents" });
    expect(log.text).not.toContain("MARBLE");
  });
});
