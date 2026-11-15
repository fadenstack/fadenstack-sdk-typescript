import { effectiveToolClass, parseToolClass, writeLog, type FadenstackLogger, type LocalMcpPlainHttpEvent, type ToolClass } from "@fadenstack/client";
import {
  CORE_TOOL_SOURCE,
  FIND_TOOL_NAME,
  OnRequestTools,
  RESERVED_TOOL_NAMES,
  type AgentBuilder,
  type AgentContext,
  type AgentTool,
  type ChangingToolSource,
  type FadenstackModule,
  type SecretProtector,
} from "@fadenstack/agents";

import { McpConnection, type ListedTool } from "./connection.js";
import { McpConfigError, McpConnectError, McpPolicyError, McpStoreError } from "./errors.js";
import { toolClassFor, type McpToolHints } from "./hints.js";
import { parseMcpConfig, type McpImportResult } from "./importConfig.js";
import { PLAIN_HTTP_EVENT_FEATURE, McpPlainHttpRefusedError, checkMcpPlainHttp, mcpOrigin, plainHttpPermitted, type McpPlainHttpRefusal } from "./plainHttp.js";
import { McpLog } from "./log.js";
import { coreLocalMcpPolicy, type LocalMcpPolicy } from "./policy.js";
import { DEFAULT_CALL_TIMEOUT_S, callTimeoutMs, checkServer, recordOf, type McpAppServer, type McpServerRecord, type RaisedClass } from "./servers.js";
import { openMcpServerStore, type McpServerStore, type StoredMcpServer, type StorePrincipal } from "./store.js";
import { oneLine } from "./text.js";

/** The module's name, as an agent profile's `required_client_modules` would name it; the .NET module's. */
export const MCP_MODULE = "mcp.local";

/** The version this client tells servers it is (`clientInfo`). */
const CLIENT_VERSION = "0.3.0";
const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** The standalone principal's tenant and user (`LocalBackend`'s): the database of a person's servers before the agent has started. */
const STANDALONE: StorePrincipal = Object.freeze({ tenantId: "standalone", userId: "standalone" });

/** Where a server is, for a host's Tools view. .NET: `McpServerState` (`Starting` is the moment of an attach). */
export const McpServerState = Object.freeze({
  /** Switched off by the person (or imported and not switched on yet). Nothing is sent. */
  Off: "off",
  /** Connected; its tools are known. */
  Running: "running",
  /** Could not be attached; `detail` says why. */
  Failed: "failed",
  /** The policy does not allow it; `detail` is the policy's reason. Never contacted. */
  NotAllowed: "notAllowed",
} as const);
export type McpServerState = (typeof McpServerState)[keyof typeof McpServerState];

/** A tool a server brought, for a host's Tools view. The description is cleaned of hidden characters and capped. .NET: `McpToolInfo`. */
export interface McpToolInfo {
  /** The name the model calls it by. */
  name: string;
  /** The name the server knows it by. */
  serverName: string;
  description: string;
  /** What the server says about it: shown, and counted only as the hint rule allows (`toolClassFor`). */
  hints: McpToolHints;
  /** The class it runs under now: `unknown` asks, `destructive` always asks. */
  toolClass: ToolClass;
  /** What the person raised it to (standalone), if anything. */
  raisedTo?: RaisedClass;
}

/** A server as a host shows it. .NET: `McpServerStatus`. */
export interface McpServerStatus {
  label: string;
  state: McpServerState;
  /** The last error (`failed`) or the policy's reason (`notAllowed`). Never an address or a header. */
  detail?: string;
  /** The first line of the server's instructions: at most 80 characters, hidden characters removed. */
  instructions?: string;
  /** The MCP revision the connection runs on (`2026-07-28`, or `2025-11-25` and older); undefined before it is attached. */
  protocolVersion?: string;
  tools: McpToolInfo[];
  /** `app` for a server the app brought, `person` for one in the person's list. */
  source: "app" | "person";
  /** Whether the server's hints count (the person's or the administrator's word). */
  trusted: boolean;
  /** The person's switch "Allow plain http on the local network" (sdk/51 F05). */
  plainHttpInLan: boolean;
  /** Why plain http to it was refused, with `notAllowed` (the app shows its own words, such as "Plain http is not allowed here"). */
  plainHttp?: McpPlainHttpRefusal;
}

/** What the MCP module offers: the person's servers, and the app's own. Which of them an agent may use is decided by its policy. */
export interface McpOptions {
  /** Servers the app brings itself: always listed, on, never stored. */
  servers?: readonly McpAppServer[];
  /**
   * The person's own servers: a store (`MemoryMcpServerStore`, `IndexedDbMcpServerStore`), `false` for none. By default IndexedDB per
   * principal (`fadenstack-mcp`, standalone as its own principal), and memory where there is no IndexedDB.
   */
  store?: McpServerStore | false;
  /** The IndexedDB factory of the default store (default `globalThis.indexedDB`). */
  indexedDB?: IDBFactory;
  /** What seals the default store's header values (default: the person's WebCrypto key). */
  protector?: SecretProtector;
  /** Decides from the agent's profile and the machine policy whether a server is on; the core rule (`coreLocalMcpPolicy`) by default. */
  policy?: LocalMcpPolicy;
  /**
   * Governed mode: the labels of the servers the administrator marked trusted, whose `readOnlyHint` counts. The person's own mark
   * means nothing there. Standalone: ignored (the person's mark is in each server's record).
   */
  trustedServers?: readonly string[];
  /** Tool names as `label_tool`, for servers whose tool names clash. Off by default. */
  prefixToolNames?: boolean;
  /** How long a server gets to answer the first request (default 30 s). */
  connectTimeoutMs?: number;
  /** The longest a call may take when the server's record does not say (default 120 s, at most 600). */
  callTimeoutS?: number;
  /** The `fetch` the transport uses (default `globalThis.fetch`): a host's own, a test's. */
  fetch?: typeof fetch;
  /** Where the module logs (labels and counts, never an address, a header or a result); the host's own logger. */
  logger?: FadenstackLogger;
}

/** What `McpModule.importConfig` did with a pasted configuration. */
export interface McpImportOutcome extends McpImportResult {
  /** The labels kept in the person's list (all off, not reviewed). */
  added: string[];
  /** The labels left out because the list has a server of that name. */
  existing: string[];
}

interface Entry {
  record: StoredMcpServer;
  source: "app" | "person";
  status: McpServerStatus;
  connection?: McpConnection;
  /** What the connection was made from, to see whether it is still the right one. */
  key?: string;
  listed?: ListedTool[];
}

/**
 * Local MCP servers as tools of a Fadenstack agent, over HTTP only: a browser cannot start a process, and there is no scan
 * (sdk/51 F05; .NET's `LocalMcpModule` also does stdio and the loopback scan). A server is attached at the start of a turn if its
 * policy allows; the person's list (`add`, `setEnabled`, `importConfig`) reaches the agent at the start of its next turn.
 *
 * The tools are not offered by default. While a server is attached the model gets one tool, `find_tool`, whose description lists
 * the servers; a search switches the best matches on for the rest of that conversation (`OnRequestTools`' scope). A tool arrives
 * unclassified, so it asks; the class comes from the hint rule (`toolClassFor`), the person's raise and the agent's contract.
 * Results are fenced as untrusted data. A tool under a name the SDK keeps for itself is left out, and the first server's tool wins
 * a name; both are logged by label.
 */
export class McpModule implements FadenstackModule, ChangingToolSource {
  /** The SDK's own source: it brings `find_tool`. A server's tool under a reserved name is left out by this module. */
  readonly [CORE_TOOL_SOURCE] = true;
  readonly name = MCP_MODULE;
  /** The person's own servers, or undefined when the app keeps none. */
  readonly store: McpServerStore | undefined;
  readonly #options: McpOptions;
  readonly #listeners = new Set<() => void>();
  readonly #statusListeners = new Set<() => void>();
  readonly #unsubscribe: (() => void) | undefined;
  readonly #onRequest = new OnRequestTools();
  readonly #entries = new Map<string, Entry>();
  readonly #cache = new Map<string, { fingerprint: string; tool: AgentTool }>();
  #principal: StorePrincipal | undefined = STANDALONE;
  /** The context of the last attach: where a change of the plain-http switch is reported. */
  #context: AgentContext | undefined;
  readonly #plainHttpChanges: LocalMcpPlainHttpEvent[] = [];
  #chain: Promise<unknown> = Promise.resolve();
  #disposed = false;

  constructor(options: McpOptions) {
    this.#options = options;
    for (const server of options.servers ?? []) checkServer(server);
    this.store = options.store === false ? undefined
      : options.store ?? openMcpServerStore({
        principal: () => this.#principal,
        ...(options.indexedDB ? { indexedDB: options.indexedDB } : {}),
        ...(options.protector ? { protector: options.protector } : {}),
      });
    this.#unsubscribe = this.store?.onChanged(() => this.refresh());
  }

  configure(builder: AgentBuilder): void {
    builder.addToolSource(this);
  }

  /** Reads the servers again at the start of the next turn (a server was added, switched, or the person changed a setting). */
  refresh(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  onChanged(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Calls `listener` when a server's status changed (attached, failed, switched off); returns the unsubscribe. .NET: `ServerChanged`. */
  onStatusChanged(listener: () => void): () => void {
    this.#statusListeners.add(listener);
    return () => {
      this.#statusListeners.delete(listener);
    };
  }

  /** The servers as of the last time the agent read them, the app's first, then the person's by label. */
  get statuses(): readonly McpServerStatus[] {
    return [...this.#entries.values()].map((e) => structuredClone(e.status));
  }

  // The person's list ------------------------------------------------------------------------------------------------

  /** The person's servers as kept, headers in the clear (the Tools view shows names only). */
  async servers(): Promise<StoredMcpServer[]> {
    return this.#need().list();
  }

  /** Adds a server to the person's list, or replaces the one of that label. It starts off unless `enabled` says otherwise. */
  async add(server: Partial<McpServerRecord> & { label: string; url: string }): Promise<void> {
    checkServer(server);
    const existing = await this.#need().get(server.label);
    await this.#need().save(recordOf({ ...existing, ...server }));
  }

  async remove(label: string): Promise<boolean> {
    return this.#need().remove(label);
  }

  /** Switches a server on or off. Switching on is the person's review: the server is no longer "not reviewed". */
  async setEnabled(label: string, enabled: boolean): Promise<void> {
    await this.#update(label, (s) => ({ ...s, enabled, ...(enabled ? { reviewed: true } : {}) }));
  }

  /** The person's word that the server's hints are true (H4): its `readOnlyHint` then counts. Standalone only. */
  async setTrusted(label: string, trusted: boolean): Promise<void> {
    await this.#update(label, (s) => ({ ...s, trusted }));
  }

  /** Raises one tool to `read` or `write`, or takes the raise back (`undefined`). A destructive hint stays a floor. Standalone only. */
  async setToolClass(label: string, serverToolName: string, raised: RaisedClass | undefined): Promise<void> {
    await this.#update(label, (s) => {
      const toolClasses = { ...s.toolClasses };
      if (raised === undefined) delete toolClasses[serverToolName];
      else toolClasses[serverToolName] = raised;
      return { ...s, toolClasses };
    });
  }

  /**
   * Imports a pasted configuration (`parseMcpConfig`) into the person's list: HTTP servers come in off and not reviewed, ones that
   * start a program are listed as not possible in a browser, and a label the list already has is left as it is.
   */
  async importConfig(text: string): Promise<McpImportOutcome> {
    const store = this.#need();
    const parsed = parseMcpConfig(text);
    const taken = new Set((await store.list()).map((s) => s.label.toLowerCase()));
    const added: string[] = [];
    const existing: string[] = [];
    for (const server of parsed.servers) {
      if (taken.has(server.label.toLowerCase())) {
        existing.push(server.label);
        continue;
      }
      await store.save(server);
      taken.add(server.label.toLowerCase());
      added.push(server.label);
    }
    return { ...parsed, added, existing };
  }

  /**
   * The person's switch "Allow plain http on the local network" for a server over plain http (sdk/51 F05). Turning it on needs the
   * version of the warning the person confirmed just before (`warningVersion`): the app shows the warning, the SDK records which
   * one. Whether the server then connects is the profile's and this computer's policy's to say (its status tells). Every change
   * goes into the device's audit log (`McpServerStore.audit`) and, in governed mode where the profile lists the feature, to the
   * server as `local_mcp.plain_http`. A server that is sent a header value cannot have it. .NET: `McpHost.SetPlainHttpInLanAsync`.
   */
  async setPlainHttpInLan(label: string, on: boolean, warningVersion?: string): Promise<void> {
    if (on && (typeof warningVersion !== "string" || warningVersion.trim() === "")) {
      throw new McpConfigError("Turning plain http on needs the version of the warning the person confirmed.");
    }
    const store = this.#need();
    const found = await store.get(label);
    if (!found) throw new McpStoreError(`There is no server '${label}' in the list.`);
    const url = new URL(found.url);
    if (url.protocol !== "http:") throw new McpConfigError(`'${label}' does not use plain http.`);
    if (on && Object.keys(found.headers).length > 0) {
      throw new McpConfigError(`'${label}' sends a header over plain http to another computer: use https.`, "plainHttpWithHeaders");
    }
    if ((found.plainHttpInLan === true) === on) return;
    await this.#update(label, (s) => {
      const { plainHttpInLan: _old, ...rest } = s;
      return recordOf(on ? { ...rest, plainHttpInLan: true } : rest);
    });
    const source = mcpOrigin(url);
    const state = on ? "on" : "off";
    const principal = this.#principal ?? STANDALONE;
    await store.appendAudit({
      event: "local_mcp.plain_http",
      at: new Date().toISOString(),
      source,
      state,
      warning_version: on ? warningVersion!.trim() : null,
      person: principal === STANDALONE || principal.userId === STANDALONE.userId ? "standalone" : `${principal.tenantId}/${principal.userId}`,
    });
    this.#plainHttpChanges.push({ type: "local_mcp.plain_http", source, state });
    if (this.#context) await this.#sendPlainHttpChanges(this.#context);
    this.refresh();
  }

  /** Sends the switch's changes, in governed mode and only where the profile lists the feature (an older core refuses the batch). */
  async #sendPlainHttpChanges(context: AgentContext): Promise<void> {
    if (this.#plainHttpChanges.length === 0) return;
    const changes = this.#plainHttpChanges.splice(0);
    if (context.connection !== "governed" || !context.profile.features.includes(PLAIN_HTTP_EVENT_FEATURE)) return;
    for (const change of changes) {
      try {
        await context.report(change);
      } catch {
        // a report that fails never fails the switch: the device's own audit log has it
      }
    }
  }

  #need(): McpServerStore {
    if (!this.store) throw new McpStoreError("This app keeps no list of the person's MCP servers.");
    return this.store;
  }

  async #update(label: string, change: (server: StoredMcpServer) => McpServerRecord): Promise<void> {
    const store = this.#need();
    const found = await store.get(label);
    if (!found) throw new McpStoreError(`There is no server '${label}' in the list.`);
    if (found.headersUnreadable === true) throw new McpStoreError(`The headers of '${label}' cannot be read any more: add the server again.`);
    await store.save(change(found));
  }

  // The agent's side -------------------------------------------------------------------------------------------------

  /**
   * The agent's tools: `find_tool` and, held back until found, every running server's tools. The class of a tool: the hint rule
   * (and, standalone, the person's raise); in governed mode the agent's contract then makes it stricter and drops what it does not list.
   */
  getTools(context: AgentContext, signal?: AbortSignal): Promise<readonly AgentTool[]> {
    const run = this.#chain.then(() => this.#attach(context, signal));
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async #attach(context: AgentContext, signal: AbortSignal | undefined): Promise<readonly AgentTool[]> {
    if (this.#disposed) return [];
    const logger = this.#options.logger;
    this.#principal = context.profile.principal ?? STANDALONE;
    this.#context = context;
    await this.#sendPlainHttpChanges(context);
    const governed = context.connection === "governed";
    const policy = this.#options.policy ?? coreLocalMcpPolicy;

    // the servers: the app's first, then the person's by label (a label the app has is not taken again)
    const wanted: { record: StoredMcpServer; source: "app" | "person" }[] = [];
    for (const app of this.#options.servers ?? []) {
      wanted.push({ source: "app", record: recordOf({ label: app.label, url: app.url, headers: app.headers ?? {}, enabled: true, trusted: app.trusted ?? false,
        ...(app.callTimeoutS !== undefined ? { callTimeoutS: app.callTimeoutS } : {}) }) });
    }
    if (this.store) {
      try {
        for (const own of await this.store.list()) {
          if (!wanted.some((w) => w.record.label.toLowerCase() === own.label.toLowerCase())) wanted.push({ source: "person", record: own });
        }
      } catch (error) {
        writeLog(logger, McpLog.storeUnreadable, { ErrorType: error instanceof Error ? error.name : typeof error });
      }
    }

    const live = new Set(wanted.map((w) => w.record.label));
    for (const [label, entry] of [...this.#entries]) {
      if (!live.has(label)) {
        await entry.connection?.close();
        this.#entries.delete(label);
      }
    }
    await Promise.all(wanted.map(async ({ record, source }) => {
      const previous = this.#entries.get(record.label);
      const entry: Entry = { record, source, status: statusOf(record, source, this.#trusted(record, governed)),
        ...(previous?.connection ? { connection: previous.connection } : {}), ...(previous?.key !== undefined ? { key: previous.key } : {}) };
      this.#entries.set(record.label, entry);
      await this.#settle(entry, context, policy, signal);
    }));
    // order: the app's, then the person's by label
    const ordered = [...this.#entries.values()].sort((a, b) => (a.source === b.source ? a.record.label.localeCompare(b.record.label) : a.source === "app" ? -1 : 1));
    this.#entries.clear();
    for (const entry of ordered) this.#entries.set(entry.record.label, entry);
    for (const listener of [...this.#statusListeners]) {
      try { listener(); } catch { /* a listener that fails never fails the attach */ }
    }

    return this.#build(ordered, context, governed);
  }

  /** Decides, connects and lists one server; every outcome lands in its status. */
  async #settle(entry: Entry, context: AgentContext, policy: LocalMcpPolicy, signal: AbortSignal | undefined): Promise<void> {
    const logger = this.#options.logger;
    const record = entry.record;
    const decision = policy.decide({ label: record.label, url: record.url }, context.profile, context.machinePolicy);
    if (!decision.allowed) {
      await this.#detach(entry);
      entry.status = { ...entry.status, state: McpServerState.NotAllowed, detail: decision.reason };
      writeLog(logger, McpLog.refused, { Label: record.label, Transport: "http", Reason: decision.reason });
      return;
    }
    if (record.headersUnreadable === true) {
      await this.#detach(entry);
      entry.status = { ...entry.status, state: McpServerState.Failed, detail: "The headers could not be decrypted; add the server again." };
      writeLog(logger, McpLog.headersUnreadable, { Label: record.label });
      return;
    }
    if (!record.enabled) {
      await this.#detach(entry);
      return;
    }
    const key = JSON.stringify([record.url, Object.entries(record.headers).sort(([a], [b]) => (a < b ? -1 : 1)), record.callTimeoutS ?? null,
      record.plainHttpInLan === true]);
    try {
      // Plain http (sdk/51 F05), every turn: a connection the rule no longer allows (the switch, the profile, the policy) stops here.
      checkMcpPlainHttp(new URL(record.url), record, plainHttpPermitted(context));
      if (entry.connection && entry.key !== key) await this.#detach(entry);
      let listed: ListedTool[] | undefined;
      if (entry.connection) {
        try {
          listed = await entry.connection.listTools(signal);
        } catch {
          await this.#detach(entry); // it stopped answering: one new attempt
        }
      }
      if (!entry.connection) {
        const url = checkServer(record);
        entry.connection = await McpConnection.open({ label: record.label, url, headers: record.headers, fetch: this.#options.fetch, signal,
          timeoutMs: this.#options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS, version: CLIENT_VERSION });
        entry.key = key;
        listed = await entry.connection.listTools(signal);
      }
      entry.listed = listed ?? [];
      const connection = entry.connection;
      entry.status = {
        ...entry.status,
        state: McpServerState.Running,
        ...(connection?.protocolVersion !== undefined ? { protocolVersion: connection.protocolVersion } : {}),
        ...(connection?.instructions !== undefined ? { instructions: connection.instructions } : {}),
      };
      delete entry.status.detail;
      delete entry.status.plainHttp;
      writeLog(logger, McpLog.attached, { Label: record.label, Transport: "http", ToolCount: entry.listed.length, Protocol: connection?.protocolVersion ?? "" });
    } catch (error) {
      await this.#detach(entry);
      if (error instanceof McpPlainHttpRefusedError) {
        // refused before anything was sent: a rule, not a failure
        entry.status = { ...entry.status, state: McpServerState.NotAllowed, detail: error.message, plainHttp: error.reason };
        writeLog(logger, McpLog.plainHttpRefused, { Label: record.label, Reason: error.reason });
        return;
      }
      const typed = error instanceof McpConnectError || error instanceof McpConfigError ? error : new McpConnectError(record.label, "unreachable", { cause: error });
      entry.status = { ...entry.status, state: McpServerState.Failed, detail: typed.message };
      writeLog(logger, McpLog.attachFailed, { Label: record.label, Transport: "http", ErrorType: typed.name + (typed instanceof McpConnectError ? `:${typed.reason}` : "") });
    }
  }

  async #detach(entry: Entry): Promise<void> {
    const connection = entry.connection;
    delete entry.connection;
    delete entry.key;
    delete entry.listed;
    await connection?.close();
  }

  #trusted(record: McpServerRecord, governed: boolean): boolean {
    return governed ? (this.#options.trustedServers ?? []).some((l) => l.toLowerCase() === record.label.toLowerCase()) : record.trusted;
  }

  /** The tools of the running servers, named, classified and handed to the tool search. */
  async #build(ordered: readonly Entry[], context: AgentContext, governed: boolean): Promise<readonly AgentTool[]> {
    const logger = this.#options.logger;
    const contract = new Map(context.profile.hostToolContract.map((t) => [t.name, t]));
    const owners = new Map<string, string>();
    const tools: AgentTool[] = [];
    const index: string[] = [];
    const fresh = new Set<string>();
    for (const entry of ordered) {
      if (entry.status.state !== McpServerState.Running || !entry.listed) continue;
      const label = entry.record.label;
      const trusted = this.#trusted(entry.record, governed);
      index.push(entry.status.instructions ? `${oneLine(label, 40)}: ${entry.status.instructions}` : oneLine(label, 40));
      const infos: McpToolInfo[] = [];
      for (const listed of entry.listed) {
        let exposed = this.#options.prefixToolNames === true ? `${label.replace(/[^A-Za-z0-9_-]/g, "_")}_${listed.name}` : listed.name;
        if (!NAME.test(exposed)) {
          exposed = exposed.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
          writeLog(logger, McpLog.toolNameInvalid, { Label: label });
          if (exposed === "") continue;
        }
        if (RESERVED_TOOL_NAMES.includes(exposed)) {
          writeLog(logger, McpLog.toolNameReserved, { Label: label });
          continue;
        }
        const winner = owners.get(exposed);
        if (winner !== undefined) {
          writeLog(logger, McpLog.toolNameTaken, { Label: label, Winner: winner });
          continue;
        }
        owners.set(exposed, label);
        // the hint rule; the person's raise counts standalone only (governed: the administrator's word is the contract)
        const raised = governed ? undefined : entry.record.toolClasses[listed.name];
        let toolClass = toolClassFor(listed.hints, { trusted, raised });
        if (governed && contract.size > 0) {
          const listedInContract = contract.get(exposed);
          if (!listedInContract) continue; // the gateway refuses what the contract does not list
          toolClass = effectiveToolClass(toolClass, parseToolClass(listedInContract.risk));
        }
        const info: McpToolInfo = { name: exposed, serverName: listed.name, description: oneLine(listed.description, 300), hints: listed.hints, toolClass,
          ...(raised !== undefined ? { raisedTo: raised } : {}) };
        infos.push(info);
        tools.push(this.#toolFor(label, exposed, listed, toolClass, fresh));
      }
      entry.status = { ...entry.status, tools: infos };
    }
    for (const name of [...this.#cache.keys()]) if (!fresh.has(name)) this.#cache.delete(name);

    this.#onRequest.set(tools);
    if (tools.length === 0) return [];
    // The tool search settles by the contract, which would make every tool without an entry unclassified: it is given the classes
    // decided here (stricter-of is then the identity), so the hint rule's result stands.
    const decided = tools.map((t) => ({ name: t.name, risk: t.toolClass }));
    const inner = await this.#onRequest.getTools({ profile: { ...context.profile, hostToolContract: decided } } as AgentContext); // it reads the profile only
    return inner.map((tool) => tool.name === FIND_TOOL_NAME
      ? { ...tool, source: "mcp", description: `${tool.description ?? ""}\nMCP servers:\n${index.join("\n")}`.replace(/^\n/, "") }
      : tool);
  }

  /** The agent's tool for a server's tool; the same object while nothing about it changed, so a conversation's switched-on tools stay on. */
  #toolFor(label: string, exposed: string, listed: ListedTool, toolClass: ToolClass, fresh: Set<string>): AgentTool {
    const fingerprint = JSON.stringify([label, listed.name, listed.description, listed.inputSchema, listed.hints, toolClass]);
    fresh.add(exposed);
    const cached = this.#cache.get(exposed);
    if (cached?.fingerprint === fingerprint) return cached.tool;
    const schema = { type: "object", properties: {}, ...listed.inputSchema } as AgentTool["parameters"];
    const tool: AgentTool = {
      name: exposed,
      ...(listed.description !== "" ? { description: listed.description } : {}),
      parameters: schema,
      toolClass,
      source: "mcp",
      server: label,
      ...(listed.hints.openWorldHint !== undefined ? { openWorld: listed.hints.openWorldHint } : {}),
      ...(listed.hints.readOnlyHint !== undefined ? { readOnlyHint: listed.hints.readOnlyHint } : {}),
      ...(listed.hints.destructiveHint !== undefined ? { destructiveHint: listed.hints.destructiveHint } : {}),
      invoke: (args, call) => this.#call(label, listed.name, args, call.signal),
    };
    this.#cache.set(exposed, { fingerprint, tool });
    return tool;
  }

  /** The call goes to the live client of the server, whatever client that is now. */
  async #call(label: string, serverTool: string, args: Record<string, unknown>, signal: AbortSignal): Promise<string> {
    const entry = this.#entries.get(label);
    const connection = entry?.connection;
    if (!entry || !connection) return `Error: the MCP server ${oneLine(label, 40)} is not attached any more.`;
    const timeoutMs = callTimeoutMs(entry.record.callTimeoutS, this.#options.callTimeoutS ?? DEFAULT_CALL_TIMEOUT_S);
    const answer = await connection.call(serverTool, args, { signal, timeoutMs });
    if (answer.startsWith("Error: the MCP server") && answer.includes("did not answer within")) {
      writeLog(this.#options.logger, McpLog.callTimedOut, { Label: label, Seconds: Math.ceil(timeoutMs / 1000) });
    }
    return answer;
  }

  /** Throws the typed error for a server the policy does not allow (for a host that wants an exception instead of a status). */
  assertAllowed(label: string): void {
    const status = this.#entries.get(label)?.status;
    if (status?.state === McpServerState.NotAllowed) throw new McpPolicyError(label, status.detail ?? "");
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe?.();
    this.#listeners.clear();
    await this.#chain.catch(() => undefined);
    for (const entry of this.#entries.values()) await entry.connection?.close();
    this.#entries.clear();
    this.#cache.clear();
    this.#statusListeners.clear();
  }
}

function statusOf(record: StoredMcpServer, source: "app" | "person", trusted: boolean): McpServerStatus {
  return { label: record.label, state: McpServerState.Off, tools: [], source, trusted, plainHttpInLan: record.plainHttpInLan === true };
}

/**
 * The MCP module (`mcp.local`), as .NET's `new LocalMcpModule(servers)`: `builder.use(mcpModule({ servers }))`. It gives the agent the
 * tools of the person's HTTP MCP servers (and the app's own) under the policy, with the hint rule and the person's list in IndexedDB.
 */
export function mcpModule(options: McpOptions = {}): McpModule {
  return new McpModule(options);
}
