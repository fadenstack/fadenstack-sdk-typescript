import type { AgentToolInfo } from "@fadenstack/client";
import {
  CloudToolsStatus,
  ImportNote,
  ImportProblem,
  ImportSkipReason,
  LocalPlainHttpRefusal,
  LocalServerState,
  LocalToolClass,
  LocalToolRaise,
  ServerProblem,
  TestOutcome,
  ToolsPolicy,
  cloudToolOf,
  type AgentConnection,
  type AgentContext,
  type AppToolInfo,
  type CloudToolsResult,
  type FadenstackAgent,
  type ImportCandidateInfo,
  type ImportPreview,
  type ImportSkipInfo,
  type LocalServerInfo,
  type LocalToolInfo,
  type LocalToolsCatalog,
  type ServerDraft,
  type ServerTestInfo,
} from "@fadenstack/agents";

import { McpConfigError, McpStoreError, type McpConfigProblem } from "./errors.js";
import { toolClassFor } from "./hints.js";
import { parseMcpConfig, type McpImportResult, type McpImportSkipped } from "./importConfig.js";
import { McpServerState, type McpModule, type McpServerStatus } from "./module.js";
import { type McpPlainHttpRefusal, plainHttpPermitted } from "./plainHttp.js";
import { DEFAULT_CALL_TIMEOUT_S, checkServer, isLoopbackUrl, recordOf, type McpServerRecord, type RaisedClass } from "./servers.js";
import { MemoryMcpServerStore, type StoredMcpServer } from "./store.js";

/** What the Tools view needs to know of the running agent; an app gives it (`agentToolsView`, or a fake in tests). */
export interface AgentToolsView {
  /** The agent has started for a signed-in person: its profile and tools are real. */
  readonly isRunning: boolean;
  readonly connection: AgentConnection;
  /** The running agent's profile and this computer's policy; undefined before it started. */
  readonly context: Pick<AgentContext, "profile" | "machinePolicy"> | undefined;
  /** The tools the agent runs, once started (the app's own have source `host`); empty before. */
  readonly tools?: readonly { readonly name: string; readonly description?: string | undefined; readonly toolClass: AppToolInfo["toolClass"]; readonly source: string }[];
  /** The cloud tools of the agent's server (`null`: the server does not list them); rejects when it cannot. */
  listCloudTools(signal?: AbortSignal): Promise<AgentToolInfo[] | null>;
  /** The agent started, or the person signed out. */
  onChanged(listener: () => void): () => void;
}

/** `AgentToolsView` of a `FadenstackAgent`. An agent raises no event when it starts: the app calls `raiseChanged` after `start()` and after a sign-out. */
export interface FadenstackAgentToolsView extends AgentToolsView {
  raiseChanged(): void;
}

export function agentToolsView(agent: FadenstackAgent): FadenstackAgentToolsView {
  const listeners = new Set<() => void>();
  return {
    get isRunning() { return agent.isStarted; },
    get connection() { return agent.connection; },
    get tools() { return agent.isStarted ? agent.tools : []; },
    get context() { return agent.isStarted ? { profile: agent.profile, machinePolicy: agent.machinePolicy } : undefined; },
    listCloudTools: (signal) => agent.listServerTools(signal),
    onChanged(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    raiseChanged() {
      for (const listener of [...listeners]) listener();
    },
  };
}

export interface McpToolsCatalogOptions {
  /** The clock, for "running since" (default `new Date()`). */
  now?: () => Date;
}

const PROBLEMS: Readonly<Record<McpConfigProblem, ServerProblem>> = {
  labelMissing: ServerProblem.LabelMissing,
  labelInvalid: ServerProblem.LabelInvalid,
  addressMissing: ServerProblem.AddressMissing,
  addressInvalid: ServerProblem.AddressInvalid,
  nameInvalid: ServerProblem.NameInvalid,
  valueInvalid: ServerProblem.ValueInvalid,
  tooManyHeaders: ServerProblem.TooManyHeaders,
  plainHttpWithHeaders: ServerProblem.PlainHttpWithHeaders,
  plainHttpNotLocal: ServerProblem.PlainHttpNotLocal,
  importEmpty: ServerProblem.AddressInvalid,
  importTooLarge: ServerProblem.AddressInvalid,
  importNotJson: ServerProblem.AddressInvalid,
  importNoList: ServerProblem.AddressInvalid,
};

const REFUSALS: Readonly<Record<McpPlainHttpRefusal, LocalPlainHttpRefusal>> = {
  noOptIn: LocalPlainHttpRefusal.NoOptIn,
  notLocal: LocalPlainHttpRefusal.NotLocal,
  secret: LocalPlainHttpRefusal.Secret,
  notAllowed: LocalPlainHttpRefusal.NotAllowed,
};

const IMPORT_PROBLEMS: Readonly<Partial<Record<McpConfigProblem, ImportProblem>>> = {
  importEmpty: ImportProblem.Empty,
  importTooLarge: ImportProblem.TooLarge,
  importNotJson: ImportProblem.NotJson,
  importNoList: ImportProblem.NoServerList,
};

const MIN_TIMEOUT_S = 5;
const MAX_TIMEOUT_S = 600;

function problemOf(error: unknown): ServerProblem {
  if (error instanceof McpConfigError && error.problem) return PROBLEMS[error.problem];
  return ServerProblem.AddressInvalid;
}

/** The address as the page shows it: without a query or a fragment, which is where a token would be. */
function shownAddress(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return "";
  }
}

/**
 * The Tools view's side of the MCP module (sdk/51 F05): the person's servers from the `McpModule`, with their trust mark, their tools'
 * classes and raises and the plain-http switch; the cloud tools from the agent's server; the pasted import. It keeps a snapshot of the
 * person's list (a browser's database answers asynchronously): every change goes through the module, the snapshot is read again, and
 * `onChanged` tells the view. It changes only what the person asked for through a command of the view; an import never sets the switch
 * or the trust mark. The header values pass through `save` and `test` only: the snapshot, the preview and every message hold names
 * alone. .NET: `McpToolsCatalog`.
 */
export class McpToolsCatalog implements LocalToolsCatalog {
  readonly #module: McpModule;
  readonly #agent: AgentToolsView | undefined;
  readonly #now: () => Date;
  readonly #listeners = new Set<() => void>();
  readonly #unsubscribe: (() => void)[] = [];
  readonly #previews = new WeakMap<ImportPreview, McpServerRecord[]>();
  readonly #runningSince = new Map<string, Date>();
  #records: StoredMcpServer[] = [];
  #unreadable = false;
  #servers: LocalServerInfo[] = [];
  #loading: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(module: McpModule, agent?: AgentToolsView, options: McpToolsCatalogOptions = {}) {
    this.#module = module;
    this.#agent = agent;
    this.#now = options.now ?? (() => new Date());
    this.#unsubscribe.push(module.onStatusChanged(() => this.#changed()));
    if (module.store) this.#unsubscribe.push(module.store.onChanged(() => void this.refresh().catch(() => undefined)));
    if (agent) this.#unsubscribe.push(agent.onChanged(() => this.#changed()));
    void this.refresh().catch(() => undefined);
  }

  /** Stops listening to the module and the agent. */
  dispose(): void {
    this.#disposed = true;
    for (const stop of this.#unsubscribe.splice(0)) stop();
    this.#listeners.clear();
  }

  onChanged(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  #changed(): void {
    if (this.#disposed) return;
    this.#servers = this.#build();
    for (const listener of [...this.#listeners]) {
      try { listener(); } catch { /* a listener that fails never fails the catalog */ }
    }
  }

  async refresh(): Promise<void> {
    const run = this.#loading.then(() => this.#read());
    this.#loading = run.catch(() => undefined);
    return run;
  }

  async #read(): Promise<void> {
    const store = this.#module.store;
    if (store) {
      try {
        this.#records = await store.list();
        this.#unreadable = false;
      } catch {
        this.#records = [];
        this.#unreadable = true;
      }
    } else {
      this.#records = [];
    }
    this.#changed();
  }

  // ---- what the page reads ------------------------------------------------------------------------------------------

  get signedIn(): boolean {
    return this.#agent?.isRunning === true && this.#module.store !== undefined;
  }

  get policy(): ToolsPolicy {
    const context = this.#agent?.context;
    if (!context) return ToolsPolicy.Unknown;
    const { profile, machinePolicy } = context;
    if (!machinePolicy.mcp.allowsAny) return ToolsPolicy.NotAllowed;
    const settings = profile.localMcp;
    if (settings?.mode === "allow") return ToolsPolicy.Allowed;
    if (settings?.developerMode === true) return ToolsPolicy.DeveloperMode;
    return ToolsPolicy.NotAllowed;
  }

  get governed(): boolean {
    return this.#agent?.connection === "governed";
  }

  get appTools(): readonly AppToolInfo[] {
    const agent = this.#agent;
    if (!agent?.isRunning) return [];
    return (agent.tools ?? [])
      .filter((t) => t.source === "host")
      .map((t) => ({ name: t.name, description: t.description ?? "", toolClass: t.toolClass }));
  }

  get plainHttpPermitted(): boolean {
    const context = this.#agent?.context;
    return this.#agent?.isRunning === true && context !== undefined && plainHttpPermitted(context);
  }

  get marksAreYours(): boolean {
    return this.#agent?.connection !== "governed";
  }

  get serversKeptOnDisk(): boolean {
    const store = this.#module.store;
    return store !== undefined && !(store instanceof MemoryMcpServerStore);
  }

  get serversUnreadable(): boolean {
    return this.#unreadable;
  }

  get localServers(): readonly LocalServerInfo[] {
    return this.#servers;
  }

  #build(): LocalServerInfo[] {
    const statuses = new Map(this.#module.statuses.filter((s) => s.source === "person").map((s) => [s.label, s]));
    const running = new Set<string>();
    const infos: LocalServerInfo[] = [];
    for (const record of this.#records) {
      const status = statuses.get(record.label);
      const info = this.#info(record, status);
      if (info.state === LocalServerState.Running) running.add(record.label);
      infos.push(info);
    }
    for (const gone of [...this.#runningSince.keys()]) if (!running.has(gone)) this.#runningSince.delete(gone);
    for (const label of running) if (!this.#runningSince.has(label)) this.#runningSince.set(label, this.#now());
    return infos.map((i) => (running.has(i.label) ? { ...i, runningSince: this.#runningSince.get(i.label) } : i));
  }

  #info(record: StoredMcpServer, status: McpServerStatus | undefined): LocalServerInfo {
    const standalone = this.marksAreYours;
    const trusted = standalone ? record.trusted : status?.trusted === true;
    const names = Object.keys(record.headers);
    let state: LocalServerState = LocalServerState.Off;
    let detail: string | undefined;
    if (record.headersUnreadable === true) {
      state = LocalServerState.Failed;
      detail = "The headers could not be decrypted; add the server again.";
    } else if (record.enabled) {
      // Switched on and not attached yet: it is attached at the start of the next message.
      state = !status || status.state === McpServerState.Off ? LocalServerState.Starting : status.state;
      detail = status?.detail;
    }
    const url = (() => { try { return new URL(record.url); } catch { return undefined; } })();
    return {
      label: record.label,
      where: shownAddress(record.url),
      enabled: record.enabled,
      state,
      ...(detail !== undefined ? { detail } : {}),
      toolsChanged: false,
      origin: record.importedFrom ?? "typed",
      tools: (status?.tools ?? []).map((t) => this.#tool(t, record, trusted, standalone)),
      secretNames: names,
      missingValues: names.filter((n) => record.headers[n] === ""),
      callTimeoutSeconds: record.callTimeoutS ?? DEFAULT_CALL_TIMEOUT_S,
      trusted,
      plainHttpApplies: url !== undefined && url.protocol === "http:" && !isLoopbackUrl(url),
      plainHttpInLan: record.plainHttpInLan === true,
      ...(status?.plainHttp ? { plainHttpRefusal: REFUSALS[status.plainHttp] } : {}),
    };
  }

  #tool(tool: McpServerStatus["tools"][number], record: StoredMcpServer, trusted: boolean, standalone: boolean): LocalToolInfo {
    const raised: RaisedClass | undefined = standalone ? record.toolClasses[tool.serverName] : undefined;
    // standalone: worked out here, so a change of the trust mark or a raise shows at once; governed: the class the agent gave it
    const toolClass = standalone ? toolClassFor(tool.hints, { trusted, raised }) : tool.toolClass;
    return {
      name: tool.serverName,
      description: tool.description,
      ...(tool.hints.title !== undefined ? { title: tool.hints.title } : {}),
      readOnly: tool.hints.readOnlyHint,
      destructive: tool.hints.destructiveHint,
      idempotent: tool.hints.idempotentHint,
      openWorld: tool.hints.openWorldHint,
      class: toolClass,
      raise: raised === "read" ? LocalToolRaise.Read : raised === "write" ? LocalToolRaise.Write : LocalToolRaise.None,
    };
  }

  // ---- cloud --------------------------------------------------------------------------------------------------------

  async getCloudTools(signal?: AbortSignal): Promise<CloudToolsResult> {
    if (!this.#agent?.isRunning) return { status: CloudToolsStatus.NotSignedIn, tools: [] };
    try {
      const tools = await this.#agent.listCloudTools(signal);
      return tools === null ? { status: CloudToolsStatus.NotListed, tools: [] } : { status: CloudToolsStatus.Listed, tools: tools.map(cloudToolOf) };
    } catch (error) {
      if (signal?.aborted) throw error;
      return { status: CloudToolsStatus.Unavailable, tools: [] };
    }
  }

  // ---- local servers ------------------------------------------------------------------------------------------------

  async setEnabled(label: string, enabled: boolean): Promise<void> {
    await this.#module.setEnabled(label, enabled);
    await this.refresh();
  }

  async setTrusted(label: string, trusted: boolean): Promise<void> {
    // In governed mode the administrator's marks count: the person's would change nothing, so they are not kept.
    if (!this.marksAreYours) return;
    await this.#module.setTrusted(label, trusted);
    await this.refresh();
  }

  async setToolClass(label: string, tool: string, raise: LocalToolRaise): Promise<void> {
    if (!this.marksAreYours) return;
    // A destructive hint is a floor: no raise is kept for such a tool. A tool the server does not list now has no known hint, so it is not raised either.
    const listed = this.#module.statuses.find((s) => s.label === label && s.source === "person")?.tools.find((t) => t.serverName === tool);
    if (!listed || listed.hints.destructiveHint === true) return;
    await this.#module.setToolClass(label, tool, raise === LocalToolRaise.None ? undefined : raise);
    await this.refresh();
  }

  async setPlainHttpInLan(label: string, on: boolean, warningVersion?: string): Promise<ServerProblem> {
    try {
      await this.#module.setPlainHttpInLan(label, on, warningVersion);
    } catch (error) {
      if (error instanceof McpConfigError) return error.problem ? problemOf(error) : ServerProblem.AddressInvalid;
      throw error;
    } finally {
      await this.refresh();
    }
    return ServerProblem.None;
  }

  async getDraft(label: string): Promise<ServerDraft | undefined> {
    const record = await this.#module.store?.get(label);
    if (!record) return undefined;
    return {
      label: record.label,
      enabled: record.enabled,
      url: record.url,
      headers: record.headersUnreadable === true ? [] : Object.keys(record.headers).map((name) => ({ name, value: "", isKept: true })),
      callTimeoutSeconds: record.callTimeoutS ?? DEFAULT_CALL_TIMEOUT_S,
    };
  }

  validate(draft: ServerDraft, originalLabel: string | undefined): ServerProblem {
    const label = draft.label.trim();
    const url = draft.url.trim();
    if (label === "") return ServerProblem.LabelMissing;
    if (url === "") return ServerProblem.AddressMissing;
    if (!Number.isInteger(draft.callTimeoutSeconds) || draft.callTimeoutSeconds < MIN_TIMEOUT_S || draft.callTimeoutSeconds > MAX_TIMEOUT_S) {
      return ServerProblem.TimeoutOutOfRange;
    }
    const names = new Set<string>();
    const headers: Record<string, string> = {};
    for (const pair of draft.headers) {
      const name = pair.name.trim();
      if (name === "") continue;
      if (names.has(name.toLowerCase())) return ServerProblem.NameInvalid;
      names.add(name.toLowerCase());
      headers[name] = pair.value;
    }
    try {
      checkServer({ label, url, headers });
    } catch (error) {
      return problemOf(error);
    }
    const mine = originalLabel?.toLowerCase();
    if (this.#records.some((r) => r.label.toLowerCase() === label.toLowerCase() && r.label.toLowerCase() !== mine)) return ServerProblem.LabelTaken;
    return ServerProblem.None;
  }

  // The saved header value stays when the draft keeps it: the page never held it. The marks and the switch of a saved server stay
  // too (an edit is not the person's word on them); the switch only while the server's origin is the one it was turned on for.
  #recordOf(draft: ServerDraft, saved: StoredMcpServer | undefined): McpServerRecord {
    const url = draft.url.trim();
    const headers: Record<string, string> = {};
    for (const pair of draft.headers) {
      const name = pair.name.trim();
      if (name === "") continue;
      headers[name] = pair.isKept && pair.value === "" ? (saved?.headers[name] ?? "") : pair.value;
    }
    const sameOrigin = (() => {
      try { return saved !== undefined && new URL(saved.url).origin === new URL(url).origin && new URL(url).protocol === "http:"; } catch { return false; }
    })();
    return recordOf({
      label: draft.label.trim(),
      url,
      headers,
      enabled: draft.enabled,
      trusted: saved?.trusted ?? false,
      toolClasses: saved?.toolClasses ?? {},
      callTimeoutS: draft.callTimeoutSeconds,
      ...(saved?.importedFrom !== undefined ? { importedFrom: saved.importedFrom } : {}),
      // switching on in the sheet is the person's review, as `setEnabled` is
      reviewed: draft.enabled ? true : (saved?.reviewed ?? true),
      ...(saved?.plainHttpInLan === true && sameOrigin ? { plainHttpInLan: true } : {}),
    });
  }

  async save(originalLabel: string | undefined, draft: ServerDraft): Promise<ServerProblem> {
    const problem = this.validate(draft, originalLabel);
    if (problem !== ServerProblem.None) return problem;
    const store = this.#module.store;
    if (!store) return ServerProblem.AddressInvalid;
    try {
      let saved = originalLabel === undefined ? undefined : await store.get(originalLabel);
      const record = this.#recordOf(draft, saved);
      if (saved?.plainHttpInLan === true && record.plainHttpInLan !== true) {
        // The address changed under a switch that was on: the switch was for the old address, so it goes off, on the record.
        await this.#module.setPlainHttpInLan(saved.label, false);
        saved = await store.get(saved.label);
      }
      await store.save(record, originalLabel);
    } catch (error) {
      if (error instanceof McpStoreError) return ServerProblem.LabelTaken;
      if (error instanceof McpConfigError) return problemOf(error);
      throw error;
    }
    await this.refresh();
    return ServerProblem.None;
  }

  async remove(label: string): Promise<void> {
    await this.#module.remove(label);
    await this.refresh();
  }

  async test(draft: ServerDraft, originalLabel: string | undefined, signal?: AbortSignal): Promise<ServerTestInfo> {
    const saved = originalLabel === undefined ? undefined : await this.#module.store?.get(originalLabel);
    const result = await this.#module.testServer(this.#recordOf(draft, saved), this.#agent?.context, signal);
    return {
      outcome: result.outcome === "notAllowed" ? TestOutcome.NotAllowed : result.outcome === "started" ? TestOutcome.Started : TestOutcome.Failed,
      tools: result.tools,
      ...(result.error !== undefined ? { error: result.error } : {}),
      ...(result.plainHttp ? { plainHttp: REFUSALS[result.plainHttp] } : {}),
    };
  }

  // ---- import -------------------------------------------------------------------------------------------------------

  async readImport(text: string): Promise<ImportPreview> {
    let parsed: McpImportResult;
    try {
      parsed = parseMcpConfig(text);
    } catch (error) {
      const problem = error instanceof McpConfigError && error.problem ? IMPORT_PROBLEMS[error.problem] : undefined;
      return { problem: problem ?? ImportProblem.NotJson, servers: [], skipped: [] };
    }
    const taken = new Set(this.#records.map((r) => r.label.toLowerCase()));
    const servers: ImportCandidateInfo[] = [];
    const records: McpServerRecord[] = [];
    const skipped: ImportSkipInfo[] = parsed.skipped.map(skipOf);
    for (const record of parsed.servers) {
      if (taken.has(record.label.toLowerCase())) {
        skipped.push({ name: record.label, reason: ImportSkipReason.LabelTaken });
        continue;
      }
      const left = parsed.leftOut[record.label] ?? [];
      servers.push({
        label: record.label,
        where: shownAddress(record.url),
        notes: left.length > 0 ? [ImportNote.HeadersLeftOut] : [],
        ...(left.length > 0 ? { detail: left.join(", ") } : {}),
      });
      records.push(record);
    }
    const preview: ImportPreview = { problem: ImportProblem.None, servers, skipped };
    this.#previews.set(preview, records);
    return preview;
  }

  async import(preview: ImportPreview, labels: readonly string[]): Promise<number> {
    const records = this.#previews.get(preview);
    const store = this.#module.store;
    if (!records || !store) return 0;
    const wanted = new Set(labels);
    const taken = new Set((await store.list()).map((r) => r.label.toLowerCase()));
    let added = 0;
    for (const record of records) {
      if (!wanted.has(record.label) || taken.has(record.label.toLowerCase())) continue;
      // arrives off, not trusted, no raises and the plain-http switch off, whatever the text said
      await store.save(recordOf({ ...record, enabled: false, trusted: false, toolClasses: {}, reviewed: false }));
      taken.add(record.label.toLowerCase());
      added++;
    }
    this.#previews.delete(preview);
    await this.refresh();
    return added;
  }

  // ---- restart ------------------------------------------------------------------------------------------------------

  async restart(label: string): Promise<void> {
    this.#runningSince.delete(label);
    await this.#module.restart(label);
    await this.refresh();
  }
}

function skipOf(skip: McpImportSkipped): ImportSkipInfo {
  switch (skip.kind) {
    case "stdio": return { name: skip.label, reason: ImportSkipReason.Program };
    case "sse": return { name: skip.label, reason: ImportSkipReason.Sse };
    case "plainHttp": return { name: skip.label, reason: ImportSkipReason.NetworkServer };
    default:
      if (skip.why === "noAddress") return { name: skip.label, reason: ImportSkipReason.NothingToStart };
      if (skip.why !== undefined) return { name: skip.label, reason: ImportSkipReason.NotValid, problem: PROBLEMS[skip.why] };
      return { name: skip.label, reason: ImportSkipReason.NotUnderstood };
  }
}
