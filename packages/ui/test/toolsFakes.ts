import {
  CloudToolsStatus,
  ImportProblem,
  ImportSkipReason,
  LocalServerState,
  LocalToolClass,
  LocalToolRaise,
  ServerProblem,
  TestOutcome,
  ToolsPolicy,
  type CloudToolInfo,
  type CloudToolsResult,
  type ImportPreview,
  type LocalPlainHttpRefusal,
  type LocalServerInfo,
  type LocalToolInfo,
  type LocalToolsCatalog,
  type ServerDraft,
  type ServerTestInfo,
} from "@fadenstack/agents";

// A catalog in memory for the Tools view's view models and skins (the MCP module's own is tested in packages/mcp). Every call that
// changes something is recorded, so a test can say what the view model asked for and with what. Header values given to `save` and
// `test` are recorded as a copy, taken at the call, because the view model clears the draft when the call returns.

export const SECRET = "Bearer s3cr3t-token";

export function tool(name: string, more: Partial<LocalToolInfo> = {}): LocalToolInfo {
  return { name, description: `${name} does its work`, class: LocalToolClass.Unknown, raise: LocalToolRaise.None, ...more };
}

export function serverInfo(label: string, more: Partial<LocalServerInfo> = {}): LocalServerInfo {
  return {
    label, where: `https://${label}.example.com/mcp`, enabled: true, state: LocalServerState.Running, toolsChanged: false, origin: "typed", tools: [tool("echo")],
    secretNames: [], missingValues: [], callTimeoutSeconds: 120, trusted: false, plainHttpApplies: false, plainHttpInLan: false, ...more,
  };
}

export class FakeCatalog implements LocalToolsCatalog {
  signedIn = true;
  policy: ToolsPolicy = ToolsPolicy.Allowed;
  serversKeptOnDisk = true;
  serversUnreadable = false;
  localServers: LocalServerInfo[] = [];
  plainHttpPermitted = false;
  marksAreYours = true;
  cloud: CloudToolsResult = { status: CloudToolsStatus.Listed, tools: [] };
  cloudFails = false;
  drafts = new Map<string, ServerDraft>();
  problem: ServerProblem = ServerProblem.None;
  switchProblem: ServerProblem = ServerProblem.None;
  testResult: ServerTestInfo = { outcome: TestOutcome.Started, tools: ["echo"] };
  preview: ImportPreview = { problem: ImportProblem.None, servers: [], skipped: [] };
  importAdds = 0;

  readonly switchCalls: { label: string; on: boolean; version: string | undefined }[] = [];
  readonly enabledCalls: { label: string; enabled: boolean }[] = [];
  readonly trustedCalls: { label: string; trusted: boolean }[] = [];
  readonly raiseCalls: { label: string; tool: string; raise: LocalToolRaise }[] = [];
  readonly saved: { original: string | undefined; draft: ServerDraft }[] = [];
  readonly tested: { original: string | undefined; draft: ServerDraft }[] = [];
  readonly removed: string[] = [];
  readonly restarted: string[] = [];
  readonly imported: { labels: readonly string[] }[] = [];
  readonly readTexts: string[] = [];
  cloudCalls = 0;
  readonly #listeners = new Set<() => void>();

  constructor(servers: LocalServerInfo[] = []) {
    this.localServers = servers;
  }

  /** Something moved in the module: the view model is told. */
  changed(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  onChanged(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  get listenerCount(): number {
    return this.#listeners.size;
  }

  async refresh(): Promise<void> { /* the fake is always current */ }

  async getCloudTools(): Promise<CloudToolsResult> {
    this.cloudCalls++;
    if (this.cloudFails) return { status: CloudToolsStatus.Unavailable, tools: [] };
    return this.cloud;
  }

  async setEnabled(label: string, enabled: boolean): Promise<void> {
    this.enabledCalls.push({ label, enabled });
    this.#change(label, (s) => ({ ...s, enabled, state: enabled ? LocalServerState.Running : LocalServerState.Off }));
  }

  async setTrusted(label: string, trusted: boolean): Promise<void> {
    this.trustedCalls.push({ label, trusted });
    this.#change(label, (s) => ({ ...s, trusted }));
  }

  async setToolClass(label: string, name: string, raise: LocalToolRaise): Promise<void> {
    this.raiseCalls.push({ label, tool: name, raise });
    this.#change(label, (s) => ({ ...s, tools: s.tools.map((t) => (t.name === name ? { ...t, raise } : t)) }));
  }

  async setPlainHttpInLan(label: string, on: boolean, warningVersion?: string): Promise<ServerProblem> {
    this.switchCalls.push({ label, on, version: warningVersion });
    if (this.switchProblem === ServerProblem.None) this.#change(label, (s) => ({ ...s, plainHttpInLan: on }));
    return this.switchProblem;
  }

  async getDraft(label: string): Promise<ServerDraft | undefined> {
    const given = this.drafts.get(label);
    if (given) return structuredClone(given);
    const s = this.localServers.find((x) => x.label === label);
    return s && { label, enabled: s.enabled, url: s.where, headers: s.secretNames.map((name) => ({ name, value: "", isKept: true })), callTimeoutSeconds: s.callTimeoutSeconds };
  }

  validate(): ServerProblem {
    return this.problem;
  }

  async save(original: string | undefined, draft: ServerDraft): Promise<ServerProblem> {
    this.saved.push({ original, draft: structuredClone(draft) });
    return this.problem;
  }

  async remove(label: string): Promise<void> {
    this.removed.push(label);
    this.localServers = this.localServers.filter((s) => s.label !== label);
    this.changed();
  }

  async test(draft: ServerDraft, original: string | undefined): Promise<ServerTestInfo> {
    this.tested.push({ original, draft: structuredClone(draft) });
    return this.testResult;
  }

  async readImport(text: string): Promise<ImportPreview> {
    this.readTexts.push(text);
    return this.preview;
  }

  async import(_preview: ImportPreview, labels: readonly string[]): Promise<number> {
    this.imported.push({ labels });
    return this.importAdds || labels.length;
  }

  async restart(label: string): Promise<void> {
    this.restarted.push(label);
  }

  #change(label: string, change: (s: LocalServerInfo) => LocalServerInfo): void {
    this.localServers = this.localServers.map((s) => (s.label === label ? change(s) : s));
    this.changed();
  }
}

export function cloudTool(name: string, server: string, more: Partial<CloudToolInfo> = {}): CloudToolInfo {
  return { name, server, description: `${name} for ${server}`, allowed: true, enabled: true, ...more };
}

export function refused(label: string, refusal: LocalPlainHttpRefusal): LocalServerInfo {
  return serverInfo(label, { where: "http://192.168.1.5:8931/mcp", state: LocalServerState.NotAllowed, plainHttpApplies: true, plainHttpRefusal: refusal, tools: [] });
}

export { ImportSkipReason };
