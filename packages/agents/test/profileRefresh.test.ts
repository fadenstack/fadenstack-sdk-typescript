import { afterEach, describe, expect, it, vi } from "vitest";

import { FadenstackUnreachableError } from "@fadenstack/client";
import { PAGE_CONTRACT, setup } from "./helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const profileReads = (s: { gateway: { requests: { path: string }[] } }) => s.gateway.requests.filter((r) => r.path.endsWith("/profile")).length;

/** The profile read again when older than a minute at a session's start or opening (39 F8). */
describe("the profile at a session's start", () => {
  it("is read again only when it is older than a minute", async () => {
    const s = await setup({ agents: [{ slug: "docs", contract: [...PAGE_CONTRACT] }] });
    await s.agent.start();
    const now = Date.now();
    expect(profileReads(s)).toBe(1);

    await s.agent.startSession();
    s.agent.clock = () => now + 59_000;
    await s.agent.startSession();
    expect(profileReads(s)).toBe(1);

    s.agent.clock = () => now + 61_000;
    await s.agent.startSession();
    expect(profileReads(s)).toBe(2);
    await s.agent.startSession(); // just read: not again
    expect(profileReads(s)).toBe(2);
  });

  it("brings a ceiling an administrator lowered, and a tool's new class, to the next session without a restart", async () => {
    const s = await setup({ agents: [{ slug: "docs", contract: [...PAGE_CONTRACT] }] });
    const first = await s.agent.startSession();
    expect([s.agent.ceiling, s.agent.find("write_page")!.toolClass, first.effectiveToolMode]).toEqual(["auto", "write", "ask"]);

    s.gateway.updateAgent("docs", { ceiling: "read_only", contract: PAGE_CONTRACT.map((c) => (c.name === "write_page" ? { ...c, risk: "destructive" as const } : c)) });
    const now = Date.now();
    s.agent.clock = () => now + 61_000;
    const second = await s.agent.startSession("ask");

    expect([s.agent.ceiling, s.agent.find("write_page")!.toolClass, second.effectiveToolMode]).toEqual(["read_only", "destructive", "read_only"]);
  });

  it("is read again when a session is opened", async () => {
    const s = await setup({ agents: [{ slug: "docs", contract: [...PAGE_CONTRACT] }] });
    const session = await s.agent.startSession("ask");
    await session.send("Hi.");
    s.gateway.updateAgent("docs", { ceiling: "read_only" });
    const now = Date.now();
    s.agent.clock = () => now + 61_000;

    const reopened = await s.agent.openSession(session.id);

    expect([s.agent.ceiling, reopened.effectiveToolMode]).toEqual(["read_only", "read_only"]);
  });

  it("stays as it was when the server cannot be reached, and a session still starts", async () => {
    const s = await setup({ agents: [{ slug: "docs", contract: [...PAGE_CONTRACT] }] });
    await s.agent.start();
    vi.spyOn(s.client.agent!, "getProfile").mockRejectedValue(new FadenstackUnreachableError("down"));
    const now = Date.now();
    s.agent.clock = () => now + 61_000;

    const session = await s.agent.startSession("ask");

    expect([session.effectiveToolMode, s.agent.ceiling]).toEqual(["ask", "auto"]);
  });

  it("refuses a profile of another signed-in user: the stores and grants are the first one's", async () => {
    const s = await setup({ principal: true, agents: [{ slug: "docs", contract: [...PAGE_CONTRACT] }] });
    await s.agent.start();
    const real = s.agent.profile;
    vi.spyOn(s.client.agent!, "getProfile").mockResolvedValue({ ...real, principal: { ...real.principal!, userId: "user-9" } });
    const now = Date.now();
    s.agent.clock = () => now + 61_000;

    await expect(s.agent.startSession()).rejects.toThrow("signed-in user changed");
  });
});
