import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import {
  ApprovalDecision,
  EntryTypes,
  IndexedDbApprovalStore,
  MAX_REASON_CHARS,
  MemoryApprovalStore,
  WebCryptoSecretProtector,
  type ChatSession,
  type KeySource,
} from "@fadenstack/agents";
import { lastToolResults, type FakeModel } from "@fadenstack/testing";

import { setup } from "./helpers.js";

// sdk/51 F08 (.NET: F08ApprovalTests): the reason for declining, approvals keyed by source, no plain record after the move.
function once(call: { name: string; arguments: Record<string, unknown> }): FakeModel {
  return (request) => (lastToolResults(request).size
    ? { text: `Done: ${[...lastToolResults(request).values()].join(" | ")}` }
    : { text: "On it.", toolCalls: [call] });
}

const decisions = (session: ChatSession) => session.transcript.filter((e) => e.type === EntryTypes.approvalDecision).map((e) => e.data);
const WRITE = { name: "write_page", arguments: { page: 8, text: "x" } };

describe("a reason for declining", () => {
  it("reaches the model and the transcript, cleaned and cut", async () => {
    const reason = `Not on page 8.\u202E${"x".repeat(700)}`;
    let told = "";
    const s = await setup({ model: (request) => {
      const results = lastToolResults(request);
      if (results.size) {
        told = [...results.values()][0]!;
        return { text: "OK." };
      }
      return { text: "On it.", toolCalls: [WRITE] };
    } }, () => ApprovalDecision.deny(reason));
    const session = await s.agent.startSession();

    await session.send("write");

    expect(told.startsWith("The user declined to run 'write_page'. Their reason: Not on page 8.x")).toBe(true);
    expect(told.includes("\u202E")).toBe(false);
    const kept = decisions(session)[0]!["reason"] as string;
    expect(kept.length).toBe(MAX_REASON_CHARS);
    expect(kept.startsWith("Not on page 8.x")).toBe(true);
  });

  it("is not recorded for an approval", async () => {
    const s = await setup({ model: once(WRITE) }, () => ApprovalDecision.approve());
    const session = await s.agent.startSession();
    await session.send("write");
    expect(decisions(session)[0]!["reason"]).toBeUndefined();
  });
});

describe("approvals keyed by where the tool comes from", () => {
  it.each([
    ["host", undefined, 0],
    ["mcp", "old-server", 1],
    [undefined, undefined, 1],
  ] as const)("an Allow always from source %s, server %s, asks %i times", async (source, server, asked) => {
    const approvals = new MemoryApprovalStore();
    await approvals.add("docs", { tool: "write_page", toolClass: "write", approvedAt: new Date().toISOString(),
      ...(source !== undefined ? { source } : {}), ...(server !== undefined ? { server } : {}) });
    const s = await setup({ model: once(WRITE) }, () => ApprovalDecision.approve(), (b) => b.useApprovalStore(approvals));
    await (await s.agent.startSession()).send("write");
    expect(s.asked).toHaveLength(asked);
  });

  it("Allow always keeps the tool's source", async () => {
    const approvals = new MemoryApprovalStore();
    const s = await setup({ model: once(WRITE) }, () => ApprovalDecision.approveAlways(), (b) => b.useApprovalStore(approvals));
    await (await s.agent.startSession()).send("write");
    expect(await approvals.list("docs")).toMatchObject([{ tool: "write_page", source: "host" }]);
  });

  it("Allow for this chat still lists the tool by name, and forgets it by name", async () => {
    const s = await setup({ model: once(WRITE) }, () => ApprovalDecision.approveForSession());
    const session = await s.agent.startSession();
    await session.send("write");
    expect([...session.approvedForSession]).toEqual(["write_page"]);
    session.resetApprovals("write_page");
    expect(session.approvedForSession.size).toBe(0);
  });
});

describe("the approval store after the move to sealed records", () => {
  it("never reads a plain record planted later, and binds a sealed one to its agent and tool", async () => {
    const factory = new IDBFactory();
    const key = crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]) as Promise<CryptoKey>;
    const keys: KeySource = { key: () => key };
    const store = new IndexedDbApprovalStore({ indexedDB: factory, protector: new WebCryptoSecretProtector(keys) });
    await store.add("docs", { tool: "write_page", toolClass: "write", approvedAt: new Date().toISOString(), source: "host" });
    expect(await store.list("docs")).toHaveLength(1);

    // Someone writes a plain "always allow" straight into the database, and copies the sealed record to another agent.
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = factory.open("fadenstack-approvals");
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const sealed = await new Promise<{ data: Uint8Array }>((resolve) => {
      const req = db.transaction(["approvals"], "readonly").objectStore("approvals").get(["docs", "write_page"]);
      req.onsuccess = () => resolve(req.result as { data: Uint8Array });
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(["approvals"], "readwrite");
      tx.objectStore("approvals").put({ agent: "docs", tool: "delete_page", toolClass: "destructive", approvedAt: new Date().toISOString(), source: "host" });
      tx.objectStore("approvals").put({ agent: "mail", tool: "write_page", data: sealed.data });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();

    const again = new IndexedDbApprovalStore({ indexedDB: factory, protector: new WebCryptoSecretProtector(keys) });
    expect((await again.list("docs")).map((a) => a.tool)).toEqual(["write_page"]);
    expect(await again.list("mail")).toEqual([]);
    again.close();
    store.close();
  });
});
