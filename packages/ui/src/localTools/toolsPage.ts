import { CloudToolsStatus, ToolsPolicy, newServerDraft, type CloudToolsResult, type LocalToolsCatalog } from "@fadenstack/agents";

import { Observable } from "../observable.js";
import { plain } from "../tools.js";
import { englishStrings, type UiStrings } from "../strings.js";
import type { ToolsHost } from "./contracts.js";
import { ImportSheetViewModel } from "./importSheet.js";
import { ServerDetailsViewModel } from "./serverDetails.js";
import { LocalServerViewModel } from "./serverCards.js";
import { ServerSheetViewModel } from "./serverSheet.js";
import { CloudGroupViewModel } from "./toolsCloud.js";

export interface ToolsPageOptions {
  /** The servers and the cloud tools (`McpToolsCatalog` of `@fadenstack/mcp`). */
  catalog: LocalToolsCatalog;
  /** The texts, asked for on every use (default: English); `retext()` says them again. */
  strings?: () => UiStrings;
}

/** The add or edit sheet, or the import sheet. */
export type ToolsSheet = ServerSheetViewModel | ImportSheetViewModel;

/** The tabs: what the app itself gives the agent, the person's MCP servers, the organisation's tools (governed only). */
export type ToolsTab = "app" | "computer" | "server";

/** A tool of this app as the "In this app" tab lists it. */
export interface AppToolRow {
  readonly name: string;
  /** Plain text, cut to a few hundred characters. */
  readonly description: string;
  readonly hasDescription: boolean;
  /** "Read", "Changes data", "Cannot be undone". */
  readonly classLabel: string;
  readonly toolClass: string;
}

/**
 * The Tools view (sdk/51 F05): a header with Add, a bar with the two places tools run (on this computer, on your server), the policy
 * chip and a filter. *On this computer* shows the person's MCP servers as cards (the details open on a card, with the trust mark, each
 * tool's class and the plain-http switch); the empty state replaces the cards while there are none. *On your server* shows the
 * organisation's tools by server, read only. Adding and editing a server and the paste-import are sheets. Everything comes from the
 * app's `LocalToolsCatalog`; every change goes back through it. .NET: `ToolsViewModel`, without Scan and the program kind.
 */
export class ToolsPageViewModel extends Observable implements ToolsHost {
  readonly catalog: LocalToolsCatalog;
  readonly #strings: () => UiStrings;
  readonly #stop: () => void;
  readonly #cards = new Map<string, LocalServerViewModel>();
  #all: LocalServerViewModel[] = [];
  #servers: readonly LocalServerViewModel[] = [];
  #cloud: CloudToolsResult | undefined;
  #cloudGroups: readonly CloudGroupViewModel[] = [];
  #cloudMessage = "";
  #canRetry = false;
  #loadingCloud = false;
  #cloudLoaded = false;
  #abort: AbortController | undefined;
  #filter = "";
  #tab: ToolsTab = "computer";
  #appRows: readonly AppToolRow[] = [];
  #appCount = 0;
  #appTab = "";
  #governed = false;
  #needsSignIn = true;
  #policyText = "";
  #policyTip = "";
  #policyIsWarning = false;
  #hasPolicy = false;
  #showsBanner = false;
  #plainHttp = false;
  #listNote = "";
  #localTab = "";
  #serverTab = "";
  #details: ServerDetailsViewModel | undefined;
  #sheet: ToolsSheet | undefined;
  #disposed = false;

  constructor(options: ToolsPageOptions) {
    super();
    this.catalog = options.catalog;
    this.#strings = options.strings ?? (() => englishStrings);
    this.#stop = this.catalog.onChanged(() => {
      if (!this.#disposed) this.refresh();
    });
    this.refresh();
  }

  /** The texts; a skin reads them from here and follows the view model when the language changes (`retext`). */
  get strings(): UiStrings {
    return this.#strings();
  }

  // ---- sign-in, policy, tabs, filter -------------------------------------------------------------------------------

  /** Nobody is signed in or the agent has not started: a short line replaces the page. */
  get needsSignIn(): boolean {
    return this.#needsSignIn;
  }

  get showsLists(): boolean {
    return !this.#needsSignIn;
  }

  /** The policy: the chip beside the tabs; the banner shows only while local servers are not allowed. */
  get policyText(): string {
    return this.#policyText;
  }

  /** The chip's tooltip: the full sentence. */
  get policyTip(): string {
    return this.#policyTip;
  }

  /** The policy is a warning (developer mode, not allowed); otherwise a success. */
  get policyIsWarning(): boolean {
    return this.#policyIsWarning;
  }

  get hasPolicy(): boolean {
    return this.#hasPolicy;
  }

  /** The policy does not allow local servers: a full banner in the flow. */
  get showsBanner(): boolean {
    return this.#showsBanner;
  }

  get bannerText(): string {
    return this.strings.toolsBannerNotAllowed;
  }

  /** Plain http on the local network is permitted here (the profile and this computer's policy): the switch is offered. */
  get plainHttpPermitted(): boolean {
    return this.#plainHttp;
  }

  /** The selected tab. */
  get tab(): ToolsTab {
    return this.#tab;
  }

  /** The tab "In this app" is selected. */
  get showsApp(): boolean {
    return this.#tab === "app";
  }

  /** The tab "On this computer" is selected. */
  get showsLocal(): boolean {
    return this.#tab === "computer";
  }

  /** The tab "On your server" is selected. */
  get showsServer(): boolean {
    return this.#tab === "server";
  }

  /** "On your server" is a tab only when the agent is connected to an organisation's server. */
  get showsServerTab(): boolean {
    return this.#governed;
  }

  /** The tabs now shown, in order. */
  get tabs(): readonly ToolsTab[] {
    return this.#governed ? ["app", "computer", "server"] : ["app", "computer"];
  }

  selectTab(tab: ToolsTab): void {
    if (tab === this.#tab || (tab === "server" && !this.#governed)) return;
    this.#tab = tab;
    this.notify();
  }

  /** The policy chip belongs to the computer's tab. */
  get showsLocalChip(): boolean {
    return this.#tab === "computer" && this.#hasPolicy;
  }

  get appTabText(): string {
    return this.#appTab;
  }

  get localTabText(): string {
    return this.#localTab;
  }

  get serverTabText(): string {
    return this.#serverTab;
  }

  /** Narrows every section by a tool's or a server's name. */
  get filter(): string {
    return this.#filter;
  }

  set filter(value: string) {
    if (value === this.#filter) return;
    this.#filter = value;
    this.#rebuild();
    this.#buildApp();
    this.#buildCloud();
    this.notify();
  }

  /** The header's Add server: on the computer's tab only (the server's tab is read only). */
  get showsAddButton(): boolean {
    return this.#tab === "computer";
  }

  // ---- in this app --------------------------------------------------------------------------------------------------

  /** The app's own tools the filter lets through, by name. */
  get appTools(): readonly AppToolRow[] {
    return this.#appRows;
  }

  /** The app gives the agent no tools of its own: one short line. */
  get showsAppEmpty(): boolean {
    return this.#appCount === 0;
  }

  /** The filter hides every one of the app's tools. */
  get showsAppNoMatch(): boolean {
    return this.#appCount > 0 && this.#appRows.length === 0;
  }

  get appEmptyText(): string {
    return this.strings.toolsAppNone;
  }

  get appNoMatchText(): string {
    return this.strings.toolsNoToolsMatch;
  }

  #buildApp(): void {
    const s = this.strings;
    const all = this.catalog.appTools;
    const needle = this.#filter.trim().toLowerCase();
    this.#appCount = all.length;
    this.#appTab = s.toolsTabApp(all.length);
    this.#appRows = all
      .filter((t) => needle === "" || t.name.toLowerCase().includes(needle))
      .map((t) => {
        const description = plain(t.description);
        return { name: t.name, description, hasDescription: description !== "", classLabel: s.approvalClass[t.toolClass], toolClass: t.toolClass };
      });
  }

  // ---- on this computer ---------------------------------------------------------------------------------------------

  /** The servers the filter lets through, as cards. */
  get servers(): readonly LocalServerViewModel[] {
    return this.#servers;
  }

  /** The person has servers (whatever the filter says). */
  get hasServers(): boolean {
    return this.#all.length > 0;
  }

  /** No servers at all: the dashed first-open card. */
  get showsEmpty(): boolean {
    return this.#all.length === 0;
  }

  /** The filter hides every server: a short line says so. */
  get showsNoMatch(): boolean {
    return this.#all.length > 0 && this.#servers.length === 0 && this.#filter.trim() !== "";
  }

  /** The servers are kept in memory only, or the saved list could not be read. */
  get listNote(): string {
    return this.#listNote;
  }

  get hasListNote(): boolean {
    return this.#listNote !== "";
  }

  // ---- on your server -----------------------------------------------------------------------------------------------

  get cloudGroups(): readonly CloudGroupViewModel[] {
    return this.#cloudGroups;
  }

  /** "This server does not list its tools yet.", "...could not be loaded right now." or "...offers no tools"; empty when there are rows. */
  get cloudMessage(): string {
    return this.#cloudMessage;
  }

  get hasCloudMessage(): boolean {
    return this.#cloudMessage !== "";
  }

  /** The list could not be loaded: Try again is offered. */
  get canRetry(): boolean {
    return this.#canRetry;
  }

  get isLoadingCloud(): boolean {
    return this.#loadingCloud;
  }

  // ---- the details and the sheets -----------------------------------------------------------------------------------

  /** The details of the server whose card was opened; undefined while none is. */
  get details(): ServerDetailsViewModel | undefined {
    return this.#details;
  }

  get isDetailsOpen(): boolean {
    return this.#details !== undefined;
  }

  /** The add or edit sheet, or the import sheet; undefined while none is open. */
  get sheet(): ToolsSheet | undefined {
    return this.#sheet;
  }

  get hasSheet(): boolean {
    return this.#sheet !== undefined;
  }

  addServer(): void {
    this.#details = undefined;
    this.#openSheet(new ServerSheetViewModel(this, undefined, newServerDraft()));
  }

  importServers(): void {
    this.#openSheet(new ImportSheetViewModel(this));
  }

  /** Opens the edit sheet of a server (from its card's fix or its details). */
  async edit(label: string): Promise<void> {
    const draft = await this.catalog.getDraft(label);
    if (!draft || this.#disposed) return;
    this.#details = undefined;
    this.#openSheet(new ServerSheetViewModel(this, label, draft));
  }

  // A sheet that is replaced is closed first: nothing it holds (typed secret values) outlives it.
  #openSheet(sheet: ToolsSheet): void {
    this.#sheet?.dispose();
    this.#sheet = sheet;
    this.notify();
  }

  /** Closes the sheet; a sheet that holds typed values forgets them. */
  closeSheet(): void {
    this.#sheet?.dispose();
    this.#sheet = undefined;
    this.notify();
  }

  openDetails(label: string): void {
    const card = this.#cards.get(label);
    if (!card) return;
    for (const other of this.#all) other.isSelected = other === card;
    this.#details = new ServerDetailsViewModel(this, card);
    this.notify();
  }

  closeDetails(): void {
    this.#details = undefined;
    for (const server of this.#all) server.isSelected = false;
    this.notify();
  }

  /** Esc: the warning of the plain-http switch first, then the question about removing, then the sheet, then the details. Whether it did anything. */
  closeTop(): boolean {
    const details = this.#details;
    if (this.#sheet) this.closeSheet();
    else if (details?.isPlainHttpWarningOpen) details.cancelPlainHttp();
    else if (details?.isConfirmingRemove) details.keep();
    else if (details) this.closeDetails();
    else return false;
    return true;
  }

  // ---- open, retext, dispose ----------------------------------------------------------------------------------------

  /** Opens the page: reads the catalog again and loads the cloud tools. */
  async open(): Promise<void> {
    await this.catalog.refresh();
    this.refresh();
    await this.loadCloud();
  }

  /** The app's language changed: every text is said again in the new one. */
  retext(): void {
    this.refresh();
    this.#buildCloud();
    this.#buildApp();
    for (const server of this.#all) server.retext();
    this.#details?.retext();
    this.#sheet?.retext();
    this.notify();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stop();
    this.#abort?.abort();
    this.#sheet?.dispose();
  }

  // ---- refresh ------------------------------------------------------------------------------------------------------

  /** Reads the catalog and brings the bar and the lists up to date in place. */
  refresh(): void {
    const s = this.strings;
    const catalog = this.catalog;
    this.#needsSignIn = !catalog.signedIn;
    this.#governed = catalog.governed;
    if (!this.#governed && this.#tab === "server") this.#tab = "computer";
    this.#buildApp();
    this.#plainHttp = catalog.plainHttpPermitted;
    const policy = catalog.policy;
    [this.#policyText, this.#policyTip, this.#policyIsWarning, this.#hasPolicy] =
      policy === ToolsPolicy.Allowed ? [s.toolsPolicyAllowed, s.toolsPolicyAllowedTip, false, true]
        : policy === ToolsPolicy.DeveloperMode ? [s.toolsPolicyDeveloper, s.toolsPolicyDeveloperTip, true, true]
          : policy === ToolsPolicy.NotAllowed ? [s.toolsPolicyNotAllowed, s.toolsBannerNotAllowed, true, true]
            : ["", "", false, false];
    this.#showsBanner = policy === ToolsPolicy.NotAllowed && !this.#needsSignIn;

    // The servers: the same card for the same label, in the catalog's order.
    const previous = this.#cards;
    const next = new Map<string, LocalServerViewModel>();
    this.#all = catalog.localServers.map((info) => {
      const found = previous.get(info.label);
      if (found) found.update(info);
      const card = found ?? new LocalServerViewModel(this, info);
      next.set(info.label, card);
      return card;
    });
    this.#cards.clear();
    for (const [label, card] of next) this.#cards.set(label, card);
    this.#rebuild();

    this.#listNote = catalog.serversUnreadable ? s.toolsListUnreadable : !catalog.serversKeptOnDisk ? s.toolsKeptInMemory : "";
    this.#localTab = s.toolsTabLocal(this.#all.reduce((sum, x) => sum + x.toolTotal, 0));

    const details = this.#details;
    if (details) {
      const card = this.#cards.get(details.label);
      if (!card) this.closeDetails();
      else details.refresh(card);
    }
    if (!this.#cloud) this.#serverTab = s.toolsTabServer(0);
    this.notify();

    if (!this.#needsSignIn && this.#governed && !this.#cloudLoaded && !this.#loadingCloud) void this.loadCloud();
  }

  // The cards the filter lets through.
  #rebuild(): void {
    this.#servers = this.#all.filter((x) => x.matches(this.#filter));
  }

  // ---- on your server -----------------------------------------------------------------------------------------------

  /** Loads the cloud tools again (opening the page, Try again). */
  async loadCloud(): Promise<void> {
    if (!this.catalog.signedIn || !this.catalog.governed) {
      this.#cloud = undefined;
      this.#cloudGroups = [];
      this.#cloudMessage = "";
      this.#canRetry = false;
      this.#serverTab = this.strings.toolsTabServer(0);
      this.notify();
      return;
    }
    this.#abort?.abort();
    const abort = new AbortController();
    this.#abort = abort;
    this.#loadingCloud = true;
    this.notify();
    let result: CloudToolsResult;
    try {
      result = await this.catalog.getCloudTools(abort.signal);
    } catch {
      if (abort.signal.aborted) return;
      result = { status: CloudToolsStatus.Unavailable, tools: [] };
    }
    if (abort.signal.aborted) return;
    this.#loadingCloud = false;
    this.#cloudLoaded = result.status !== CloudToolsStatus.NotSignedIn;
    this.#cloud = result;
    this.#buildCloud();
    this.notify();
  }

  /** "Try again": loads the cloud tools again. */
  retry(): Promise<void> {
    return this.loadCloud();
  }

  #buildCloud(): void {
    const s = this.strings;
    const result = this.#cloud;
    if (!result) {
      this.#cloudGroups = [];
      this.#serverTab = s.toolsTabServer(0);
      return;
    }
    this.#canRetry = result.status === CloudToolsStatus.Unavailable;
    this.#cloudMessage = result.status === CloudToolsStatus.NotListed ? s.toolsCloudNotListed
      : result.status === CloudToolsStatus.Unavailable ? s.toolsCloudUnavailable
        : result.status === CloudToolsStatus.Listed && result.tools.length === 0 ? s.toolsCloudNone : "";
    this.#serverTab = s.toolsTabServer(result.tools.length);
    const byServer = new Map<string, typeof result.tools[number][]>();
    for (const tool of result.tools) byServer.set(tool.server, [...(byServer.get(tool.server) ?? []), tool]);
    const groups: CloudGroupViewModel[] = [];
    for (const [server, tools] of [...byServer].sort(([a], [b]) => a.localeCompare(b, undefined, { sensitivity: "base" }))) {
      const group = new CloudGroupViewModel(s, server, tools, this.#filter); // the server's own order inside
      if (group.tools.length > 0) groups.push(group);
    }
    this.#cloudGroups = groups;
  }

  // ---- what the cards and the sheets ask ----------------------------------------------------------------------------

  async switchServer(label: string, on: boolean): Promise<void> {
    await this.run(this.catalog.setEnabled(label, on));
    this.refresh();
  }

  async run(work: Promise<unknown>): Promise<void> {
    try {
      await work;
    } catch {
      // nothing is logged here: an error of a catalog call can name a server, and the page reads the catalog again below
      this.refresh();
    }
  }
}
