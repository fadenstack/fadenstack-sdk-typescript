import { describe, expect, it } from "vitest";

import { EntryTypes, MAX_HOOK_NOTES, defineTool, toolHook, type AgentHooks, type ToolCallHookContext, type ToolCallHookResult,
  type ToolHookVerdict } from "@fadenstack/agents";
import type { FadenstackLogger, LogEvent } from "@fadenstack/client";
import { lastToolResults, type FakeModel } from "@fadenstack/testing";

import { PAGE_CONTRACT, setup } from "./helpers.js";

const SENTINEL = "SENTINEL-HOOK-41";

const NOTES = { agents: [{ slug: "docs", contract: [...PAGE_CONTRACT, { name: "stamp" }] }] };

function callsOnce(tool: string, args: Record<string, unknown>): FakeModel {
  return (request) => (lastToolResults(request).size ? { text: "Done." } : { text: "", toolCalls: [{ id: "call-1", name: tool, arguments: args }] });
}

/** A hook that records what it sees, tagged by name, and answers as it is told. */
function probe(name: string, log: string[], verdict?: (context: ToolCallHookContext) => ToolHookVerdict | void) {
  const seen = { before: [] as ToolCallHookContext[], after: [] as ToolCallHookResult[], modelBefore: [] as unknown[], modelAfter: [] as { outcome: string; text: string | undefined; toolCallCount: number }[] };
  const hooks: AgentHooks = {
    beforeModelCall: (c) => { log.push(`${name}:before-model`); seen.modelBefore.push(c); },
    afterModelCall: (r) => { log.push(`${name}:after-model`); seen.modelAfter.push(r); },
    beforeToolCall: (c) => { log.push(`${name}:before-tool`); seen.before.push(c); return verdict?.(c); },
    afterToolCall: (r) => { log.push(`${name}:after-tool`); seen.after.push(r); },
  };
  return { hooks, seen };
}

describe("hooks", () => {
  it("run before-hooks by order then registration, and after-hooks in the reverse", async () => {
    const log: string[] = [];
    const [a, b, c, d] = ["a", "b", "c", "d"].map((n) => probe(n, log));
    const s = await setup({ ...NOTES, model: callsOnce("read_page", { page: 7 }) }, undefined,
      (builder) => builder.addHooks(c!.hooks, 5).addHooks(a!.hooks, 1).addHooks(b!.hooks, 1).addHooks(d!.hooks, -3));
    const session = await s.agent.startSession("auto");
    await session.send("Go");
    expect(log.filter((l) => l.endsWith("tool"))).toEqual(
      ["d:before-tool", "a:before-tool", "b:before-tool", "c:before-tool", "c:after-tool", "b:after-tool", "a:after-tool", "d:after-tool"]);
    expect(log.filter((l) => l.endsWith("model")).slice(0, 8)).toEqual(
      ["d:before-model", "a:before-model", "b:before-model", "c:before-model", "c:after-model", "b:after-model", "a:after-model", "d:after-model"]);
  });

  it("show a tool hook the call and the policy's decision, and the after-hook the outcome and a host tool's result", async () => {
    const p = probe("p", []);
    const s = await setup({ ...NOTES, model: callsOnce("read_page", { page: 7 }) }, undefined, (b) => b.addHooks(p.hooks));
    const session = await s.agent.startSession("auto");
    const result = await session.send("Go");
    expect(s.asked).toHaveLength(0);
    expect(p.seen.before).toHaveLength(1);
    expect(p.seen.before[0]).toMatchObject({ toolName: "read_page", source: "host", toolClass: "read", callId: "call-1", decision: "runs",
      agentName: "docs", turnId: result.turnId, sessionId: session.id, arguments: { page: 7 } });
    expect(p.seen.after[0]).toMatchObject({ outcome: "ok", decision: "runs", resultText: "Table T1, 4 rows" });
    expect(Object.isFrozen(p.seen.before[0])).toBe(true);
    expect(Object.isFrozen(p.seen.before[0]!.arguments)).toBe(true);
  });

  it("show a call the policy asks about as `asks`, and a declined one ends denied", async () => {
    const p = probe("p", []);
    const s = await setup({ ...NOTES, model: callsOnce("write_page", { page: 8, text: "x" }) }, () => ({ approved: false }), (b) => b.addHooks(p.hooks));
    const session = await s.agent.startSession("ask");
    await session.send("Go");
    expect(s.asked).toHaveLength(1);
    expect(p.seen.before[0]!.decision).toBe("asks");
    expect(p.seen.after[0]!.outcome).toBe("denied");
  });

  it.each([["delete_page", "destructive", { page: 7 }], ["stamp", "unknown", {}]] as const)(
    "cannot get a %s call (%s) run without the card by going on", async (tool, toolClass, args) => {
      const p = probe("p", [], () => toolHook.continue());
      const s = await setup({ ...NOTES, model: callsOnce(tool, { ...args }) }, () => ({ approved: false }),
        (b) => b.addHooks(p.hooks).addTools(defineTool({ name: "stamp", description: "Stamps.", run: () => "stamped" })));
      const session = await s.agent.startSession("auto");
      await session.send("Go");
      expect(s.asked.map((a) => a.toolClass)).toEqual([toolClass]);
      expect(s.pages.deleted).toEqual([]);
      expect(p.seen.before[0]!.decision).toBe("asks");
    });

  it("leave a call the policy refused refused, whatever a hook answers", async () => {
    for (const verdict of [toolHook.continue(), toolHook.ask("please"), toolHook.deny("no"), { action: "approve" } as never]) {
      const p = probe("p", [], () => verdict);
      const s = await setup({ ...NOTES, model: callsOnce("delete_page", { page: 7 }) }, () => ({ approved: true }), (b) => b.addHooks(p.hooks));
      const session = await s.agent.startSession("read_only");
      const result = await session.send("Go");
      expect(result.outcome).toBe("tool_denied");
      expect(s.asked).toHaveLength(0);
      expect(s.pages.deleted).toEqual([]);
      expect(p.seen.before[0]!.decision).toBe("refused");
      expect(p.seen.after[0]!.outcome).toBe("denied");
    }
  });

  it("has no answer that approves: an unknown answer counts as going on, and the card is still shown", async () => {
    // JavaScript callers can return anything; only "ask" and "deny" change a call, and nothing loosens one.
    for (const verdict of [{ action: "approve" }, { action: "allow", approved: true }, { action: "run" }, "approve", 7, null] as never[]) {
      const p = probe("p", [], () => verdict);
      const s = await setup({ ...NOTES, model: callsOnce("delete_page", { page: 7 }) }, () => ({ approved: false }), (b) => b.addHooks(p.hooks));
      const session = await s.agent.startSession("auto");
      await session.send("Go");
      expect(s.asked.map((a) => a.toolName)).toEqual(["delete_page"]);
      expect(s.pages.deleted).toEqual([]);
    }
    expect(Object.keys(toolHook).sort()).toEqual(["ask", "continue", "deny"]);
  });

  it("cannot change a class: the context is frozen and a changed copy changes nothing", async () => {
    let tried: unknown;
    const hooks: AgentHooks = {
      beforeToolCall: (c) => {
        try { (c as { toolClass: string }).toolClass = "read"; } catch (error) { tried = error; }
        try { (c.arguments as Record<string, unknown>)["page"] = 8; } catch { /* frozen */ }
      },
    };
    const s = await setup({ ...NOTES, model: callsOnce("delete_page", { page: 7 }) }, () => ({ approved: false }), (b) => b.addHooks(hooks));
    const session = await s.agent.startSession("auto");
    await session.send("Go");
    expect(tried).toBeInstanceOf(TypeError);
    expect(s.asked.map((a) => [a.toolName, a.toolClass])).toEqual([["delete_page", "destructive"]]);
    expect(s.asked[0]!.arguments).toEqual({ page: 7 });
  });

  it("let a hook ask for a call the policy would run unasked, even after an 'allow always'", async () => {
    const p = probe("p", [], () => toolHook.ask("The app wants to see this one."));
    const s = await setup({ ...NOTES, model: callsOnce("write_page", { page: 8, text: "a" }) }, () => ({ approved: true, always: true }), (b) => b.addHooks(p.hooks));
    const session = await s.agent.startSession("auto");
    await session.send("Go");
    expect(p.seen.before[0]!.decision).toBe("runs");
    expect(s.asked).toHaveLength(1);
    expect(s.asked[0]).toMatchObject({ reason: "The app wants to see this one." });
    expect(s.asked[0]!.canAllowAlways).toBe(false);
    // asked again the next time: the "always" it answered was not taken
    s.gateway.setModel(callsOnce("write_page", { page: 8, text: "b" }));
    await session.send("Again");
    expect(s.asked).toHaveLength(2);
  });

  it("let a hook deny: the reason is cut to 500 characters and the model hears a declined call", async () => {
    const p = probe("p", [], () => toolHook.deny("x".repeat(600)));
    const s = await setup({ ...NOTES, model: callsOnce("read_page", { page: 7 }) }, undefined, (b) => b.addHooks(p.hooks));
    const session = await s.agent.startSession("auto");
    const result = await session.send("Go");
    expect(result.outcome).toBe("tool_denied");
    expect(s.asked).toHaveLength(0);
    const text = String(lastToolResults(s.gateway.modelCalls[1]!).values().next().value);
    expect(text).toBe(`'read_page' was declined by the app (${"x".repeat(500)}).`);
    expect(p.seen.after[0]!.outcome).toBe("denied");
  });

  it("stop the before-hooks after a deny, and a later ask does not undo it", async () => {
    const log: string[] = [];
    const first = probe("a", log, () => toolHook.deny("stop"));
    const second = probe("b", log, () => toolHook.ask());
    const s = await setup({ ...NOTES, model: callsOnce("read_page", { page: 7 }) }, undefined, (b) => b.addHooks(first.hooks, 0).addHooks(second.hooks, 1));
    const session = await s.agent.startSession("auto");
    await session.send("Go");
    expect(s.asked).toHaveLength(0);
    expect(log).not.toContain("b:before-tool");
    expect(log).toContain("b:after-tool");
  });

  it("keep a hook's notes bounded in the call's transcript entry, and never send them to the server", async () => {
    const notes: Record<string, string> = { ["k".repeat(100)]: "v".repeat(300) };
    for (let i = 1; i < 20; i++) notes[`key${i}`] = "v".repeat(300);
    const p = probe("p", [], () => toolHook.continue(notes));
    const s = await setup({ ...NOTES, model: callsOnce("read_page", { page: 7 }) }, undefined, (b) => b.addHooks(p.hooks));
    const session = await s.agent.startSession("auto");
    await session.send("Go");
    await s.agent.flush();
    const entry = session.transcript.find((e) => e.type === EntryTypes.toolComplete)!;
    const kept = entry.data["notes"] as Record<string, string>;
    expect(Object.keys(kept)).toHaveLength(MAX_HOOK_NOTES);
    expect(Object.keys(kept)).toContain("k".repeat(64));
    expect(Object.values(kept).every((v) => v === "v".repeat(200))).toBe(true);
    const sent = JSON.stringify([s.gateway.requests, s.gateway.modelCalls, s.gateway.reported]);
    expect(sent).not.toContain("vvvvvvvv");
    expect(sent).not.toContain("key1");
  });

  it("write no notes field for a call without notes, or an agent without hooks", async () => {
    const s = await setup({ ...NOTES, model: callsOnce("read_page", { page: 7 }) });
    const session = await s.agent.startSession("auto");
    await session.send("Go");
    expect(session.transcript.find((e) => e.type === EntryTypes.toolComplete)!.data).not.toHaveProperty("notes");
  });

  it("never break the run when they throw: the error is logged without its message, and the call goes on as the policy decided", async () => {
    const events: LogEvent[] = [];
    const logger: FadenstackLogger = { log: (e) => { events.push(e); } };
    class Throwing implements AgentHooks {
      beforeModelCall(): void { throw new Error(`model ${SENTINEL}`); }
      afterModelCall(): void { throw new Error(`after model ${SENTINEL}`); }
      beforeToolCall(): never { throw new RangeError(`before tool ${SENTINEL}`); }
      afterToolCall(): Promise<void> { return Promise.reject(new TypeError(`after tool ${SENTINEL}`)); }
    }
    const log: string[] = [];
    const later = probe("later", log);
    const s = await setup({ ...NOTES, model: callsOnce("delete_page", { page: 7 }) }, () => ({ approved: true }),
      (b) => b.useLogging(logger).addHooks(new Throwing(), -1).addHooks(later.hooks, 0));
    const session = await s.agent.startSession("auto");
    const result = await session.send("Go");
    expect(result.outcome).toBe("completed");
    expect(s.asked).toHaveLength(1); // a destructive call still asked
    expect(s.pages.deleted).toEqual([7]);
    expect(log).toContain("later:before-tool");
    expect(log).toContain("later:after-tool");
    const failures = events.filter((e) => e.eventId === 2060);
    expect(failures).toHaveLength(6);
    expect(failures.every((f) => f.message.includes("Throwing"))).toBe(true);
    expect(failures.some((f) => f.message.includes("RangeError"))).toBe(true);
    expect(failures.some((f) => f.message.includes("TypeError"))).toBe(true);
    expect(JSON.stringify(events)).not.toContain(SENTINEL);
  });

  it("show a model hook names, ids, counts and the outcome, and text only when the app asks for content", async () => {
    const plain = probe("p", []);
    const s = await setup({ ...NOTES, model: callsOnce("read_page", { page: 7 }) }, undefined, (b) => b.addHooks(plain.hooks));
    const session = await s.agent.startSession("auto");
    const result = await session.send("Go");
    expect(plain.seen.modelBefore).toHaveLength(2);
    expect(plain.seen.modelBefore[0]).toMatchObject({ agentName: "docs", sessionId: session.id, turnId: result.turnId, round: 1, messageCount: 1, toolCount: 3, messages: undefined });
    expect(plain.seen.modelAfter.map((a) => a.outcome)).toEqual(["ok", "ok"]);
    expect(plain.seen.modelAfter[0]!.toolCallCount).toBe(1);
    expect(plain.seen.modelAfter.every((a) => a.text === undefined)).toBe(true);

    const asked = probe("c", []);
    const t = await setup({ ...NOTES, model: callsOnce("read_page", { page: 7 }) }, undefined, (b) => b.addHooks(asked.hooks).useHookContent());
    expect(t.agent.contentLogging.isOn).toBe(false); // offered is not on
    t.agent.startContentLogging(60 * 60 * 1000);
    await (await t.agent.startSession("auto")).send("Go");
    expect((asked.seen.modelBefore[0] as { messages: unknown[] }).messages.length).toBeGreaterThan(0);
    expect(asked.seen.modelAfter[1]!.text).toBe("Done.");
  });

  it("report a failed model call to the after-hook as an error", async () => {
    const p = probe("p", []);
    const s = await setup({ ...NOTES, model: () => { throw new Error("model down"); } }, undefined, (b) => b.addHooks(p.hooks));
    const session = await s.agent.startSession("auto");
    await session.send("Go").catch(() => undefined);
    expect(p.seen.modelAfter[0]!.outcome).toBe("error");
  });
});
