import { MemoryApprovalStore, IndexedDbApprovalStore, type ApprovalStore, type StoredApproval } from "./approvalStore.js";
import { IndexedDbSessionStore } from "./indexedDbSessionStore.js";
import { browserSecretProtector, type IndexedDbKeyStore, type SecretProtector } from "./secretProtection.js";
import { MemorySessionStore, type SessionRetention, type SessionStore } from "./sessionStore.js";
import { deleteDatabase, listsAgents, type StoreProblemHandler } from "./storeSupport.js";
import type { TranscriptEntry } from "./transcript.js";
import { userStoreName, type StorePrincipal } from "./userData.js";

/**
 * What `FadenstackAgent.deleteMyData` did: how many of the SDK's own stores it removed, and whether a store the host passed was
 * left to the host (it may hold other people's data, so the SDK does not empty it; the host deletes this person's part).
 * .NET: `DataDeletion` (`FoldersRemoved` is `storesCleared` here: IndexedDB databases, not folders).
 */
export interface DataDeletion {
  /** The IndexedDB databases removed: the user's sessions, their "Allow always", and their key. */
  storesCleared: number;
  hostSessionStoreLeft: boolean;
  hostApprovalStoreLeft: boolean;
  /** Whether the person's data may still be in a store the host passed. */
  hostStoresLeft: boolean;
}

/** One session in an export. */
export interface ExportedSession {
  agent: string;
  id: string;
  started: string;
  lastActivity: string;
  title: string | null;
  /** Every entry of the transcript, decrypted. */
  entries: TranscriptEntry[];
}

/** What an access request (GDPR Art. 15 and 20) gets: the person's data on this device as one JSON document. */
export interface MyDataExport {
  format: "fadenstack-my-data";
  version: 1;
  /** ISO 8601, UTC. */
  exportedAt: string;
  sessions: ExportedSession[];
  approvals: { agent: string; approvals: StoredApproval[] }[];
  counts: { agents: number; sessions: number; approvals: number; unreadable: number };
  /** What is not in it, and why (as .NET's README says). */
  notIncluded: string[];
}

const NOT_INCLUDED = [
  "Sign-in tokens and other secrets: they give access to your account and are never exported.",
  "Anything the server keeps (accounts, requests it served, audit and usage records): ask the operator of your Fadenstack server for it.",
];

/**
 * Reads everything the stores hold -- through the stores, so decrypted the way they decrypt -- into one document. A store that
 * cannot name its agents (the host's own) is read for `slug` only. `unreadable` counts what could not be read.
 */
export async function buildExport(sessions: SessionStore, approvals: ApprovalStore, slug: string, unreadable: () => number): Promise<MyDataExport> {
  const before = unreadable();
  let failed = 0;
  const sessionAgents = listsAgents(sessions) ? await sessions.agents() : [slug];
  const approvalAgents = listsAgents(approvals) ? await approvals.agents() : [slug];
  const exportedSessions: ExportedSession[] = [];
  for (const agent of sessionAgents) {
    for (const info of await sessions.list(agent)) {
      try {
        const entries = await sessions.read(agent, info.id);
        exportedSessions.push({ agent, id: info.id, started: info.started, lastActivity: info.lastActivity, title: info.title, entries });
      } catch {
        failed++; // damaged: it cannot be read, so it cannot be handed over
      }
    }
  }
  const exportedApprovals: MyDataExport["approvals"] = [];
  let approvalCount = 0;
  for (const agent of approvalAgents) {
    const list = await approvals.list(agent);
    if (list.length > 0) {
      exportedApprovals.push({ agent, approvals: list });
      approvalCount += list.length;
    }
  }
  return {
    format: "fadenstack-my-data",
    version: 1,
    exportedAt: new Date().toISOString(),
    sessions: exportedSessions,
    approvals: exportedApprovals,
    counts: {
      agents: new Set([...sessionAgents, ...approvalAgents]).size,
      sessions: exportedSessions.length,
      approvals: approvalCount,
      unreadable: failed + (unreadable() - before),
    },
    notIncluded: [...NOT_INCLUDED],
  };
}

/**
 * The names of the databases a user has on this device: sessions, "Allow always", their key, and their preferences (the
 * thinking level picked per agent, `reasoningStoreName`).
 */
export function userDatabaseNames(principal: StorePrincipal | undefined): { sessions: string; approvals: string; keys: string; preferences: string } {
  return {
    sessions: userStoreName("fadenstack-sessions", principal),
    approvals: userStoreName("fadenstack-approvals", principal),
    keys: userStoreName("fadenstack-keys", principal),
    preferences: userStoreName("fadenstack-preferences", principal),
  };
}

/**
 * Deletes the user's databases (their key with them, so no copy can ever be read again, and their preferences, as .NET's
 * `DeleteMyDataAsync` removes the user's whole folder); returns how many existed. Close them first: an open one blocks.
 */
export async function deleteUserDatabases(principal: StorePrincipal | undefined, factory: IDBFactory | undefined = globalThis.indexedDB): Promise<number> {
  if (!factory) return 0;
  const names = userDatabaseNames(principal);
  let removed = 0;
  for (const name of [names.sessions, names.approvals, names.keys, names.preferences]) if (await deleteDatabase(factory, name)) removed++;
  return removed;
}

export interface DefaultStoresOptions {
  principal: StorePrincipal | undefined;
  retention: SessionRetention;
  /** The host's protector; without one the SDK makes a WebCrypto key for the user (browsers only). */
  protector?: SecretProtector | undefined;
  onProblem: StoreProblemHandler;
  /** Which stores the host did not pass. */
  sessions: boolean;
  approvals: boolean;
}

/**
 * The stores the host did not pass: in the signed-in user's own IndexedDB databases, encrypted with their key -- or in
 * memory where there is no IndexedDB (Node), where the SDK writes nothing and keeps no key.
 */
export class DefaultStores {
  readonly sessions: SessionStore | undefined;
  readonly approvals: ApprovalStore | undefined;
  readonly #keys: IndexedDbKeyStore | undefined;

  constructor(options: DefaultStoresOptions) {
    const indexed = !!globalThis.indexedDB;
    const names = userDatabaseNames(options.principal);
    let protector = options.protector;
    if (!protector && indexed && (options.sessions || options.approvals)) {
      const made = browserSecretProtector(names.keys);
      protector = made?.protector;
      this.#keys = made?.keys;
    }
    const common = { ...(protector ? { protector } : {}), onProblem: options.onProblem };
    this.sessions = !options.sessions ? undefined
      : indexed ? new IndexedDbSessionStore({ name: names.sessions, retention: options.retention, ...common }) : new MemorySessionStore();
    this.approvals = !options.approvals ? undefined
      : indexed ? new IndexedDbApprovalStore({ name: names.approvals, ...common }) : new MemoryApprovalStore();
  }

  setRetention(retention: SessionRetention): void {
    if (this.sessions instanceof IndexedDbSessionStore) this.sessions.setRetention(retention);
  }

  close(): void {
    (this.sessions as { close?: () => void } | undefined)?.close?.();
    (this.approvals as { close?: () => void } | undefined)?.close?.();
    void this.#keys?.closeAsync();
  }

  /** Closes every connection and waits, so the databases can be deleted. */
  async closeAsync(): Promise<void> {
    await (this.sessions as { closeAsync?: () => Promise<void> } | undefined)?.closeAsync?.();
    await (this.approvals as { closeAsync?: () => Promise<void> } | undefined)?.closeAsync?.();
    await this.#keys?.closeAsync();
  }
}
