import { BROWSER_LOG_DATABASE } from "./browserLog.js";
import { MemoryApprovalStore, IndexedDbApprovalStore, type ApprovalStore, type StoredApproval } from "./approvalStore.js";
import { IndexedDbAuditLog, MemoryAuditLog, type AuditLog, type AuditVerification } from "./audit.js";
import { IndexedDbSessionStore } from "./indexedDbSessionStore.js";
import { browserSecretProtector, type IndexedDbKeyStore, type SecretProtector } from "./secretProtection.js";
import { MemorySessionStore, type SessionRetention, type SessionStore } from "./sessionStore.js";
import { deleteDatabase, listsAgents, type StoreProblemHandler } from "./storeSupport.js";
import type { TranscriptEntry } from "./transcript.js";
import { readPersonalDatabases, type PersonalDatabases } from "./personalData.js";
import type { DataScope, MyDataApp, MyDataPlan } from "./myData.js";
import { deletePersonalLocalEntries, pageLocalStorage, personalLocalEntries, userStoreName, type StorePrincipal } from "./userData.js";

/**
 * What `FadenstackAgent.deleteMyData` did: how many of the SDK's own stores it removed, and whether a store the host passed was
 * left to the host (it may hold other people's data, so the SDK does not empty it; the host deletes this person's part).
 * .NET: `DataDeletion` (`FoldersRemoved` is `storesCleared` here: IndexedDB databases, not folders).
 */
export interface DataDeletion {
  /**
   * How many of the person's things the SDK removed: their IndexedDB databases that existed (up to eight: sessions, "Allow always",
   * their key, preferences, provenance, skills, skill switches, MCP servers) and their `localStorage` keys (the panel's language
   * and notice, the saved prompts; one count per key), plus what the host's own data held (`HostData`).
   */
  storesCleared: number;
  hostSessionStoreLeft: boolean;
  hostApprovalStoreLeft: boolean;
  /** Whether the person's data may still be in a store the host passed. */
  hostStoresLeft: boolean;
  /** What was removed: this app's data, or all of the person's (the default is this app's, since 0.3.0). */
  scope: DataScope;
  /**
   * For `thisApp`: the other apps that use the person's data in this browser, for which the shared data (skills, the MCP list, keys,
   * provenance records, the person's other preferences and the data key) stayed. Empty: it went too.
   */
  otherApps: string[];
  /** Whether the shared data stayed because other apps use it. */
  sharedDataKept: boolean;
  /** This app's agents whose data stayed because another app uses the same agent. */
  agentsKept: string[];
}

/**
 * The host's own data that "Remove my data" takes with the SDK's (`AgentBuilder.useHostData`): what the page keeps beside the SDK's
 * stores, such as the sample's key store. The SDK removes it for both scopes (it is the host's own data, one app's), and the removal's
 * `storesCleared` counts it like the SDK's own. A name that does not exist counts nothing. .NET: `AgentBuilder.UseHostData`
 * (a callback only; the .NET SDK has no IndexedDB or `localStorage`).
 */
export interface HostData {
  /** Names of IndexedDB databases to delete; one count per database that existed. Close the host's connections on `versionchange`. */
  indexedDb?: readonly string[];
  /** Prefixes of `localStorage` keys to delete; one count per key. */
  localStoragePrefixes?: readonly string[];
  /** The host's own removal, for what the lists above cannot name: returns how many things it removed. Runs after the lists. */
  remove?(scope: DataScope, signal?: AbortSignal): Promise<number>;
}

/**
 * Removes the host's data (`HostData`); how many things went. `factory` and `storage` default to the page's (where there is none, the
 * lists remove nothing).
 */
export async function deleteHostData(
  host: HostData | undefined, scope: DataScope, signal?: AbortSignal,
  factory: IDBFactory | undefined = globalThis.indexedDB, storage: Storage | undefined = pageLocalStorage(),
): Promise<number> {
  if (!host) return 0;
  let removed = 0;
  if (factory) for (const name of host.indexedDb ?? []) if (await deleteDatabase(factory, name)) removed++;
  if (storage) {
    for (const prefix of host.localStoragePrefixes ?? []) {
      if (!prefix) continue; // an empty prefix would take every key of the page
      const names: string[] = [];
      for (let i = 0; i < storage.length; i++) {
        const name = storage.key(i);
        if (name !== null && name.startsWith(prefix)) names.push(name);
      }
      for (const name of names) {
        storage.removeItem(name);
        removed++;
      }
    }
  }
  if (host.remove) removed += await host.remove(scope, signal);
  return removed;
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
  counts: { agents: number; sessions: number; approvals: number; unreadable: number; databases?: number; records?: number; localStorage?: number };
  /**
   * The person's other databases, by an allowlist per database and object store (new in this version; absent from an older
   * export): `preferences`, `skills`, `skill-switches`, `provenance` (records and placement log, never the key), `mcp` (the
   * servers without header values, with a clean address, and the audit log). A database that does not exist is absent. Rows of an
   * object store without a key path come as `{ key, value }`. The `keys` database is never read.
   */
  databases?: Record<string, Record<string, unknown[]>>;
  /** The person's `localStorage` entries (the panel's language and notice, the saved prompts), by name, as text. Absent where there is none. */
  localStorage?: { name: string; value: string }[];
  /**
   * The person's record of tool calls (sdk/51 8.10): `csv` is what `AuditLog.export("csv")` gives, with the verification result at the
   * top; `verification` says the same as a value. Absent for an export of `thisApp` while other apps use the person's data: the record
   * is shared data, like the provenance records, and goes with "Remove all" or when no other app uses the browser. No prompt, answer,
   * argument or result text is in it, only a hash of each call's arguments. .NET: `audit/tool-calls.csv` in the ZIP.
   */
  auditLog?: { csv: string; verification: AuditVerification };
  /** What is not in it, and why (as .NET's README says). */
  notIncluded: string[];
  /** What the export covers (the default is this app's, since 0.3.0). Absent from an older export, which held everything. */
  scope?: DataScope;
  /** For `thisApp`: the app. */
  app?: string;
  /** For `thisApp` while other apps use the person's data: the apps whose data (and the shared data) is not in it. */
  otherApps?: string[];
  /** For `thisApp`: this app's agents whose chats are not in it because another app uses the same agent. */
  agentsKept?: string[];
}

/** The calling app and what a removal of its data takes, for an export of `thisApp`. */
export interface ExportScope {
  app: string;
  plan: MyDataPlan;
}

const NOT_INCLUDED = [
  "Sign-in tokens and other secrets: they give access to your account and are never exported.",
  "The keys that protect your data on this device (the encryption key of your chats and the device's signing key for provenance records), and the values of your MCP servers' headers, which can hold tokens.",
  "Anything the server keeps (accounts, requests it served, audit and usage records): ask the operator of your Fadenstack server for it.",
];

/**
 * Reads everything the stores hold -- through the stores, so decrypted the way they decrypt -- into one document. A store that
 * cannot name its agents (the host's own) is read for `slug` only. `unreadable` counts what could not be read.
 */
export async function buildExport(sessions: SessionStore, approvals: ApprovalStore, slug: string, unreadable: () => number, personal?: { principal: StorePrincipal | undefined }, scope?: ExportScope, audit?: AuditLog): Promise<MyDataExport> {
  const before = unreadable();
  let failed = 0;
  // This app only, while other apps use the person's data: exactly what its removal takes (owner, 16 Nov).
  const only = scope && !scope.plan.sharedGoes ? new Set(scope.plan.ownAgents) : undefined;
  const sessionAgents = (listsAgents(sessions) ? await sessions.agents() : [slug]).filter((a) => !only || only.has(a));
  const approvalAgents = (listsAgents(approvals) ? await approvals.agents() : [slug]).filter((a) => !only || only.has(a));
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
  // The person's other databases and their localStorage keys: everything `deleteMyData` removes, without secrets.
  let others = personal ? await readPersonalDatabases(personal.principal) : undefined;
  if (others && scope && only) others = ownDatabases(others, scope);
  // The person's localStorage keys are shared by every app of the browser: they stay with the other apps.
  const local = personal && !only ? personalLocalEntries(pageLocalStorage(), personal.principal).map((e) => ({ name: e.name, value: e.value })) : undefined;
  // The record of tool calls is shared data: in this app's export only when no other app uses the browser (the rule of its removal).
  let auditLog: MyDataExport["auditLog"];
  if (audit && !only) {
    try {
      auditLog = { csv: await audit.export("csv"), verification: await audit.verify() };
    } catch {
      failed++; // it cannot be read, so it cannot be handed over
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
      unreadable: failed + (unreadable() - before) + (others?.unreadable ?? 0),
      ...(others ? { databases: others.found, records: others.records } : {}),
      ...(local ? { localStorage: local.length } : {}),
    },
    ...(others ? { databases: others.databases } : {}),
    ...(local && local.length > 0 ? { localStorage: local } : {}),
    ...(auditLog ? { auditLog } : {}),
    notIncluded: [...NOT_INCLUDED, ...(scope && only ? stayed(scope.plan) : [])],
    scope: scope ? "thisApp" : "allApps",
    ...(scope ? { app: scope.app } : {}),
    ...(scope && only ? { otherApps: scope.plan.otherApps.map((a) => a.name), agentsKept: [...scope.plan.keptAgents] } : {}),
  };
}

function stayed(plan: MyDataPlan): string[] {
  const lines = [plan.otherApps.length > 0
    ? `What other Fadenstack apps in this browser use (${plan.otherApps.map((a) => a.name).join(", ")}): your skills, your MCP servers, your provenance records, your record of tool calls and your other settings. Export all of your Fadenstack data to get them.`
    // A server that names no user: the data is this browser's, shared by every agent in it.
    : "The other agents' chats and the settings this browser shares between Fadenstack apps. Export all of your Fadenstack data to get them."];
  if (plan.keptAgents.length > 0) lines.push(`The chats of ${plan.keptAgents.join(", ")}, which another app uses too.`);
  return lines;
}

/** This app's part of the person's other databases: its record, and its agents' thinking levels (the rest stays, other apps use it). */
function ownDatabases(all: PersonalDatabases, scope: ExportScope): PersonalDatabases {
  const databases: PersonalDatabases["databases"] = {};
  let records = 0;
  const mine = (all.databases["apps"]?.["apps"] ?? []).filter((r) => (r as { app?: unknown }).app === scope.app);
  if (mine.length > 0) {
    databases["apps"] = { apps: mine };
    records += mine.length;
  }
  const own = new Set(scope.plan.ownAgents);
  const picks = (all.databases["preferences"]?.["reasoning"] ?? []).filter((r) => own.has(String((r as { agent?: unknown }).agent)));
  if (picks.length > 0) {
    databases["preferences"] = { reasoning: picks };
    records += picks.length;
  }
  return { databases, found: Object.keys(databases).length, records, unreadable: all.unreadable };
}

/**
 * The names of the databases a user has on this device: sessions, "Allow always", their key, their preferences and their provenance key and log (the
 * thinking level picked per agent, `reasoningStoreName`).
 */
export function userDatabaseNames(principal: StorePrincipal | undefined): { sessions: string; approvals: string; keys: string; preferences: string; provenance: string; skills: string; skillSwitches: string; mcp: string; webSearch: string; apps: string; audit: string; log: string } {
  return {
    sessions: userStoreName("fadenstack-sessions", principal),
    approvals: userStoreName("fadenstack-approvals", principal),
    keys: userStoreName("fadenstack-keys", principal),
    preferences: userStoreName("fadenstack-preferences", principal),
    provenance: userStoreName("fadenstack-provenance", principal),
    // The person's own skills (@fadenstack/skills, sdk/51 F04): their data, so they go with it.
    skills: userStoreName("fadenstack-skills", principal),
    // The person's on/off switches for skills, in a database of their own beside the skills.
    skillSwitches: userStoreName("fadenstack-skill-switches", principal),
    // The person's own MCP servers (@fadenstack/mcp, sdk/51 F05): their header values are sealed under the person's key, and go with it.
    mcp: userStoreName("fadenstack-mcp", principal),
    // The person's web search provider and their sealed Brave key (sdk/51 F06).
    webSearch: userStoreName("fadenstack-web-search", principal),
    // Which apps use the person's data (names, agent slugs and times; no content): the per-app removal reads it (0.3.0).
    apps: userStoreName("fadenstack-apps", principal),
    // The person's record of tool calls (sdk/51 8.10): shared by every app of the browser, so it goes with the person's whole data.
    audit: userStoreName("fadenstack-audit", principal),
    // The small log of the SDK's own entries on the device (`AgentBuilder.useBrowserLog`): names, ids, counts, no content; it goes with the person's data.
    log: userStoreName(BROWSER_LOG_DATABASE, principal),
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
  for (const name of [names.sessions, names.approvals, names.keys, names.preferences, names.provenance, names.skills, names.skillSwitches, names.mcp, names.webSearch, names.apps, names.audit, names.log]) if (await deleteDatabase(factory, name)) removed++;
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
  /** Whether the SDK keeps the record of tool calls itself (the host passed none, and not both of the stores above). */
  audit?: boolean;
}

/**
 * The stores the host did not pass: in the signed-in user's own IndexedDB databases, encrypted with their key -- or in
 * memory where there is no IndexedDB (Node), where the SDK writes nothing and keeps no key.
 */
export class DefaultStores {
  readonly sessions: SessionStore | undefined;
  readonly approvals: ApprovalStore | undefined;
  /** The record of tool calls, where the SDK keeps it. */
  readonly audit: AuditLog | undefined;
  readonly #keys: IndexedDbKeyStore | undefined;

  constructor(options: DefaultStoresOptions) {
    const indexed = !!globalThis.indexedDB;
    const names = userDatabaseNames(options.principal);
    let protector = options.protector;
    if (!protector && indexed && (options.sessions || options.approvals || options.audit)) {
      const made = browserSecretProtector(names.keys);
      protector = made?.protector;
      this.#keys = made?.keys;
    }
    const common = { ...(protector ? { protector } : {}), onProblem: options.onProblem };
    this.sessions = !options.sessions ? undefined
      : indexed ? new IndexedDbSessionStore({ name: names.sessions, retention: options.retention, ...common }) : new MemorySessionStore();
    this.approvals = !options.approvals ? undefined
      : indexed ? new IndexedDbApprovalStore({ name: names.approvals, ...common }) : new MemoryApprovalStore();
    this.audit = !options.audit ? undefined
      : indexed ? new IndexedDbAuditLog({ name: names.audit, ...(protector ? { protector } : {}) }) : new MemoryAuditLog();
  }

  /** The limits chats are pruned by; undefined: pruning is off. */
  setRetention(retention: SessionRetention | undefined): void {
    if (this.sessions instanceof IndexedDbSessionStore) this.sessions.setRetention(retention);
  }

  close(): void {
    (this.sessions as { close?: () => void } | undefined)?.close?.();
    (this.approvals as { close?: () => void } | undefined)?.close?.();
    (this.audit as { close?: () => void } | undefined)?.close?.();
    void this.#keys?.closeAsync();
  }

  /** Closes every connection and waits, so the databases can be deleted. */
  async closeAsync(): Promise<void> {
    await (this.sessions as { closeAsync?: () => Promise<void> } | undefined)?.closeAsync?.();
    await (this.approvals as { closeAsync?: () => Promise<void> } | undefined)?.closeAsync?.();
    await (this.audit as { closeAsync?: () => Promise<void> } | undefined)?.closeAsync?.();
    await this.#keys?.closeAsync();
  }
}

/** Removes the person's `localStorage` keys (see `personalLocalEntries`); how many. Where there is none: 0. */
export function deleteUserLocalStorage(principal: StorePrincipal | undefined, storage: Storage | undefined = pageLocalStorage()): number {
  return deletePersonalLocalEntries(storage, principal);
}
