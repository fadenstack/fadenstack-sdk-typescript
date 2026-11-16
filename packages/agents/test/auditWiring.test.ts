import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import {
  ARGUMENTS_SHA256_FEATURE,
  ApprovalDecision,
  AuditDecisions,
  AuditOutcomes,
  AuditScopes,
  FadenstackAgent,
  MachinePolicy,
  MemoryApprovalStore,
  MemoryAuditLog,
  STANDALONE_PRINCIPAL,
  argumentsSha256,
  denyAllApprovals,
  userStoreName,
  type AuditLog,
  type AuditRecord,
} from "@fadenstack/agents";
import { FakeGateway, lastToolResults, type FakeModel, type FakeReply } from "@fadenstack/testing";

import { PAGE_CONTRACT, Pages, setup } from "./helpers.js";

/**
 * Where the agent writes the record of tool calls (sdk/51 8.10): every call's decision and outcome, content-free, in every mode; the
 * hash of the arguments' text in the events and answers only for a server that lists the feature; the record in "Your data in this
 * browser". ASVS 5.0 V16 (security logging). Port of the .NET AuditWiringTests.
 */
describe("the agent's record of tool calls", () => {
  beforeEach(() => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const sha = (text: string) => argumentsSha256(text);

  /** A model that makes the next call of the script in each turn, then says what the script's last word is. */
  const scripted = (calls: { name: string; arguments: Record<string, unknown> | string; id?: string }[]): FakeModel => {
    const queue = [...calls];
    return (request): FakeReply => (lastToolResults(request).size || queue.length === 0 ? { text: "Done." } : { toolCalls: [queue.shift()!] });
  };

  const audited = (log: AuditLog) => (b: ReturnType<typeof FadenstackAgent.createBuilder>) => b.useAuditLog(log);
  const sayYes = () => Promise.resolve(ApprovalDecision.approve());

  it("records a call the mode runs with the hash of the arguments text exactly as the model wrote it", async () => {
    const text = '{ "page" : 7 }'; // spaces the SDK's own JSON would not write back
    const log = new MemoryAuditLog();
    const s = await setup({ model: scripted([{ name: "read_page", arguments: text }]) }, sayYes, (b) => b.useAuditLog(log).describeApp({ name: "Word add-in" }));

    await (await s.agent.startSession("auto")).send("Read.");

    const [entry, ...more] = log.entries;
    expect(more).toEqual([]);
    expect(entry).toMatchObject({ kind: "tool", app: "Word add-in", agent: "docs", tool: "read_page", class: "read", source: "host",
      decision: AuditDecisions.mode, outcome: AuditOutcomes.ran, argumentsSha256: await sha(text) });
    expect(entry!.scope).toBeUndefined();
    expect(entry!.chat).not.toBe("");
    expect(entry!.turn).not.toBe("");
    expect((await log.verify()).intact).toBe(true);
  });

  it("names every decision the loop makes", async () => {
    const log = new MemoryAuditLog();
    const answers = [ApprovalDecision.approve(), ApprovalDecision.deny("no"), ApprovalDecision.approveForSession()];
    const s = await setup({ model: scripted([
      { name: "write_page", arguments: { page: 1, text: "first" } }, // asked, once
      { name: "write_page", arguments: { page: 1, text: "second" } }, // asked, declined
      { name: "write_page", arguments: { page: 1, text: "third" } }, // asked, for this chat
      { name: "write_page", arguments: { page: 1, text: "fourth" } }, // the chat's approval stands
      { name: "no_such_tool", arguments: {} },
      { name: "read_page", arguments: "not json" },
    ]) }, () => Promise.resolve(answers.shift()!), audited(log));
    const session = await s.agent.startSession("ask");

    for (let i = 1; i <= 6; i++) await session.send(`Go ${i}`);

    expect(log.entries.map((e) => [e.tool, e.decision, e.scope, e.outcome])).toEqual([
      ["write_page", AuditDecisions.askedApproved, AuditScopes.once, AuditOutcomes.ran],
      ["write_page", AuditDecisions.askedDenied, undefined, AuditOutcomes.refused],
      ["write_page", AuditDecisions.askedApproved, AuditScopes.chat, AuditOutcomes.ran],
      ["write_page", AuditDecisions.savedApproval, AuditScopes.chat, AuditOutcomes.ran],
      ["(unknown)", AuditDecisions.none, undefined, AuditOutcomes.notRun],
      ["read_page", AuditDecisions.none, undefined, AuditOutcomes.notRun], // arguments that are not JSON
    ]);
    expect(log.entries.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("records a call the app cannot ask about as the floor, and a hidden tool as hidden", async () => {
    const log = new MemoryAuditLog();
    const s = await setup({ model: scripted([{ name: "delete_page", arguments: { page: 1 } }, { name: "write_page", arguments: { page: 1, text: "x" } }]) },
      sayYes, (b) => b.useAuditLog(log).useApprovals(denyAllApprovals)); // destructive in ask: asks; nobody can answer

    await (await s.agent.startSession("ask")).send("Delete.");
    await (await s.agent.startSession("read_only")).send("Write.");

    expect(log.entries.map((e) => [e.tool, e.decision, e.outcome])).toEqual([
      ["delete_page", AuditDecisions.floor, AuditOutcomes.refused],
      ["write_page", AuditDecisions.hidden, AuditOutcomes.refused],
    ]);
  });

  it("records a kept always-approval as a saved approval", async () => {
    const store = new MemoryApprovalStore();
    await store.add("docs", { tool: "write_page", toolClass: "write", approvedAt: "2026-11-16T09:00:00.000Z", source: "host" });
    const log = new MemoryAuditLog();
    const s = await setup({ model: scripted([{ name: "write_page", arguments: { page: 1, text: "x" } }]) }, sayYes, (b) => b.useAuditLog(log).useApprovalStore(store));

    await (await s.agent.startSession("ask")).send("Write.");

    expect(log.entries.map((e) => [e.decision, e.scope, e.outcome])).toEqual([[AuditDecisions.savedApproval, AuditScopes.always, AuditOutcomes.ran]]);
  });

  it("holds no prompt, answer, argument or result text", async () => {
    const log = new MemoryAuditLog();
    const s = await setup({ model: scripted([{ name: "write_page", arguments: { page: 1, text: "SECRET-ARGUMENT" } }]) }, sayYes, audited(log));

    await (await s.agent.startSession("ask")).send("SECRET-PROMPT");

    const everything = JSON.stringify(log.entries) + await log.export("csv") + await log.export("html");
    for (const secret of ["SECRET-ARGUMENT", "SECRET-PROMPT", "written"]) expect(everything).not.toContain(secret);
  });

  it("does not break the turn when the log cannot be written", async () => {
    const broken: AuditLog = {
      append: (_: AuditRecord) => Promise.reject(new Error("disk full")),
      verify: () => Promise.reject(new Error("no")), export: () => Promise.reject(new Error("no")), prune: () => Promise.resolve(0),
    };
    const s = await setup({ model: scripted([{ name: "read_page", arguments: { page: 7 } }]) }, sayYes, audited(broken));

    const result = await (await s.agent.startSession("auto")).send("Read.");

    expect(result.text).toBe("Done.");
  });

  // ---- the server's events: the hash only for a server that lists the feature ----

  it("with the feature, the events carry the arguments hash", async () => {
    const text = '{"page":1,"text":"x"}';
    const s = await setup({ features: [ARGUMENTS_SHA256_FEATURE], model: scripted([{ name: "write_page", arguments: text }]) }, sayYes, audited(new MemoryAuditLog()));

    await (await s.agent.startSession("ask")).send("Write.");

    const events = s.gateway.reported;
    expect(events.find((e) => e["type"] === "tool.executed")?.["arguments_sha256"]).toBe(await sha(text));
    expect(events.find((e) => e["type"] === "approval.decided")?.["arguments_sha256"]).toBe(await sha(text));
  });

  it("without the feature, nothing new is sent", async () => {
    const s = await setup({ model: scripted([{ name: "write_page", arguments: '{"page":1,"text":"x"}' }]) }, sayYes, audited(new MemoryAuditLog()));

    await (await s.agent.startSession("ask")).send("Write.");

    expect(s.gateway.reported.length).toBeGreaterThan(0);
    expect(JSON.stringify(s.gateway.reported)).not.toContain("arguments_sha256");
  });

  it.each([true, false])("the answer to a call the server holds carries the hash only with the feature (%s)", async (feature) => {
    const log = new MemoryAuditLog();
    const call = { name: "mcp.github.comment", arguments: { title: "x" } };
    const s = await setup({
      ...(feature ? { features: [ARGUMENTS_SHA256_FEATURE] } : {}),
      model: (request) => (lastToolResults(request).size ? { text: "Done." } : { text: "Commenting.", gatewayTool: { ...call, approval: { rule: true, toolClass: "write", withArguments: true } } }),
    }, sayYes, audited(log));

    await (await s.agent.startSession("ask")).send("Comment.");

    const answer = s.gateway.approvals[0]!;
    expect(answer.argumentsSha256).toBe(feature ? await sha(JSON.stringify(call.arguments)) : undefined);
    const [entry] = log.entries;
    expect([entry?.tool, entry?.source, entry?.decision]).toEqual(["mcp.github.comment", "gateway", AuditDecisions.askedApproved]);
    expect(entry?.argumentsSha256).toBe(await sha(JSON.stringify(call.arguments))); // the record keeps it either way, as far as the SDK knows it
  });

  // ---- retention ----

  it("the start removes entries older than 180 days, or than the policy's days", async () => {
    async function remaining(policy: string | undefined): Promise<number> {
      const log = new MemoryAuditLog();
      const old = (days: number): AuditRecord => ({ app: "a", agent: "docs", chat: "c", turn: "t", tool: "t", class: "read", decision: "mode", outcome: "ran",
        time: new Date(Date.now() - days * 86_400_000).toISOString() });
      await log.append(old(200));
      await log.append(old(10));
      const s = await setup({}, sayYes, (b) => (policy ? b.useAuditLog(log).useMachinePolicy(MachinePolicy.fromJson(policy)) : b.useAuditLog(log)));
      await s.agent.start();
      expect((await log.verify()).intact).toBe(true);
      return log.entries.length;
    }

    expect(await remaining(undefined)).toBe(1);
    expect(await remaining('{"auditRetentionDays":30}')).toBe(1);
    expect(await remaining('{"auditRetentionDays":365}')).toBe(2);
  });

  // ---- in the browser: the person's database, "Your data in this browser" ----

  const PERSON = { tenantId: "tenant-1", userId: "user-1" };
  const users = [{ email: "anna@example.com", password: "secret" }];
  const gatewayFor = (model: FakeModel) => new FakeGateway({ users, principal: true, model, agents: [{ slug: "docs", contract: [...PAGE_CONTRACT] }, { slug: "desktop-assistant" }] });

  async function app(gateway: FakeGateway, slug: string, name: string): Promise<FadenstackAgent> {
    const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: slug, fetch: gateway.fetch });
    await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "anna@example.com", password: "secret", fetch: gateway.fetch }));
    const pages = new Pages();
    return FadenstackAgent.createBuilder().useClient(client).addTools(pages.read, pages.write, pages.delete).describeApp({ name })
      .useApprovals(() => Promise.resolve(ApprovalDecision.approve())).build();
  }

  const names = async () => (await indexedDB.databases()).map((d) => d.name).filter((n) => n?.startsWith("fadenstack-audit"));
  const auditDb = userStoreName("fadenstack-audit", PERSON);

  it("by default the log is an encrypted database of the person's own, and two apps write into the same chain", async () => {
    const gateway = gatewayFor(scripted([{ name: "read_page", arguments: { page: 7 } }, { name: "read_page", arguments: { page: 8 } }, { name: "read_page", arguments: { page: 7 } }]));
    const word = await app(gateway, "docs", "Word add-in");
    const excel = await app(gateway, "docs", "Excel add-in");

    await (await word.startSession("auto")).send("Read.");
    await (await excel.startSession("auto")).send("Read.");
    await (await word.startSession("auto")).send("Read.");

    expect(await names()).toEqual([auditDb]);
    expect(await word.verifyAudit()).toMatchObject({ intact: true, entries: 3 });
    const csv = await excel.exportAudit("csv");
    expect(csv).toContain("Word add-in");
    expect(csv).toContain("Excel add-in");
    await word.dispose();
    await excel.dispose();
  });

  it("the export of all data holds the record as a csv with its verification", async () => {
    const gateway = gatewayFor(scripted([{ name: "read_page", arguments: { page: 7 } }]));
    const word = await app(gateway, "docs", "Word add-in");
    await (await word.startSession("auto")).send("Read.");

    const exported = await word.exportMyData({ scope: "allApps" });

    expect(exported.auditLog?.verification).toMatchObject({ intact: true, entries: 1 });
    expect(exported.auditLog?.csv.startsWith("verification,intact,entries,")).toBe(true);
    expect(exported.auditLog?.csv).toContain("read_page");
    expect(JSON.stringify(exported)).not.toContain("fadenstack.audit");
    await word.dispose();
  });

  it("the record is shared data: it stays while another app uses the browser, and goes with remove all or the last app", async () => {
    const gateway = gatewayFor(scripted([{ name: "read_page", arguments: { page: 7 } }]));
    const word = await app(gateway, "docs", "Word add-in");
    const desktop = await app(gateway, "desktop-assistant", "Desktop agent");
    await desktop.start();
    await (await word.startSession("auto")).send("Read.");

    const kept = await word.deleteMyData();
    expect(kept.sharedDataKept).toBe(true);
    expect(await names()).toEqual([auditDb]);
    expect((await word.exportMyData()).auditLog).toBeUndefined(); // not this app's: named in what stayed
    expect((await word.exportMyData()).notIncluded.join(" ")).toContain("record of tool calls");

    await word.deleteMyData({ scope: "allApps" });
    expect(await names()).toEqual([]);
    await word.dispose();
    await desktop.dispose();
  });

  it("the last app takes the record with it, and a server without a user keeps it in the shared database", async () => {
    const gateway = gatewayFor(scripted([{ name: "read_page", arguments: { page: 7 } }, { name: "read_page", arguments: { page: 8 } }]));
    const word = await app(gateway, "docs", "Word add-in");
    await (await word.startSession("auto")).send("Read.");
    expect((await word.deleteMyData()).sharedDataKept).toBe(false);
    expect(await names()).toEqual([]);
    await word.dispose();

    const anonymous = new FakeGateway({ users, model: scripted([{ name: "read_page", arguments: { page: 7 } }]), agents: [{ slug: "docs", contract: [...PAGE_CONTRACT] }] });
    const nobody = await app(anonymous, "docs", "Word add-in");
    await (await nobody.startSession("auto")).send("Read.");
    expect(await names()).toEqual(["fadenstack-audit"]);
    await nobody.deleteMyData(); // this app's part: the device's record is shared by every agent on it
    expect(await names()).toEqual(["fadenstack-audit"]);
    await nobody.deleteMyData({ scope: "allApps" });
    expect(await names()).toEqual([]);
    await nobody.dispose();
    expect(STANDALONE_PRINCIPAL.userId).toBe("standalone");
  });
});
