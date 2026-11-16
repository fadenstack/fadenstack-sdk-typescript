import { planMyData, type DataDeletion, type DataScope, type FadenstackAgent, type MyDataApp, type MyDataExport } from "@fadenstack/agents";

import { Observable } from "../observable.js";
import { englishStrings, type UiStrings } from "../strings.js";
import type { StringsSource } from "../skills/contracts.js";

/** Where the "Your data" control reads and writes: an agent (`new MyDataSettingsViewModel({ agent })`), or a test's. */
export interface MyDataSource {
  /** This app's name for the person's data (what the host described, else the agent's slug). */
  readonly appName: string;
  /** Gets ready (an agent starts). */
  start(): Promise<void>;
  /** The apps that use the person's data, this app first. */
  apps(): Promise<MyDataApp[]>;
  /** The person's data in `scope`, as the document to hand over. */
  export(scope: DataScope): Promise<MyDataExport>;
  /** Removes the person's data in `scope`. */
  remove(scope: DataScope): Promise<DataDeletion>;
}

export interface MyDataSettingsOptions {
  /** The agent whose person's data it is. Give this or `source`. */
  agent?: FadenstackAgent;
  /** Where the data comes from and goes to (a test's). */
  source?: MyDataSource;
  /** The texts; English by default. */
  strings?: StringsSource;
}

/**
 * What an export hands the app to save: the app chooses where (a download, a file picker, a folder). The view model proposes the
 * file name and keeps nothing of the content.
 */
export interface MyDataSaveRequest {
  /** A suggested file name, such as `fadenstack-my-data-word-add-in-2026-11-16.json`. */
  fileName: string;
  scope: DataScope;
  /** The document as JSON (`application/json`). */
  content: Blob;
  /** The same document, as text. */
  text: string;
}

/** Where the control is: its actions, a question, work in progress, or an answer. */
export type MyDataPhase = "idle" | "confirmThisApp" | "confirmAll" | "busy" | "done" | "error";

/**
 * The "Your data" control an app places in its settings (GDPR Art. 15, 17 and 20): "Export my data" and "Remove my data…" for this app,
 * and "Export all my Fadenstack data" and "Remove all my Fadenstack data in this browser…" for every app. A removal asks first, in the
 * control: for this app what goes and, when other apps use shared data, that skills, MCP servers, keys and provenance records stay
 * because they are used by those apps; for all, the apps it affects. Then a result line. An export raises a save request
 * (`onSaveRequest`) with a suggested file name. A skin binds to this class and holds no logic: the texts come from `strings` (say them again
 * on `retext()`); errors show as a sentence, never as exception text. .NET: the "Your data on this device" control.
 */
export class MyDataSettingsViewModel extends Observable {
  readonly #source: MyDataSource;
  readonly #strings: StringsSource;
  readonly #handlers = new Set<(request: MyDataSaveRequest) => void>();
  #phase: MyDataPhase = "idle";
  #apps: MyDataApp[] = [];
  #statusKind: "none" | "exported" | "removedThisApp" | "removedAll" | "exportFailed" | "removeFailed" = "none";
  #file = "";
  #deletion: DataDeletion | undefined;

  constructor(options: MyDataSettingsOptions) {
    super();
    const { agent, source } = options;
    if (!agent && !source) throw new TypeError("Give an agent or a source.");
    this.#source = source ?? agentSource(agent!);
    this.#strings = options.strings ?? (() => englishStrings);
  }

  /** The texts the view model was given. */
  get strings(): UiStrings {
    return this.#strings();
  }

  /** Starts the agent and reads the apps that use the person's data. */
  async load(): Promise<void> {
    await this.#source.start();
    await this.#readApps();
    this.notify();
  }

  /** The apps that use the person's data, this app first (as known at the last read). */
  get apps(): readonly MyDataApp[] {
    return this.#apps;
  }

  /** This app's name. */
  get appName(): string {
    return this.#source.appName;
  }

  get phase(): MyDataPhase {
    return this.#phase;
  }

  /** Work is in progress: the actions are off. */
  get isBusy(): boolean {
    return this.#phase === "busy";
  }

  /** The four actions show (not while a question is open or work is in progress). */
  get showActions(): boolean {
    return this.#phase === "idle" || this.#phase === "done" || this.#phase === "error";
  }

  /** The actions can be pressed. */
  get canAct(): boolean {
    return this.showActions;
  }

  /** The removal asks first: a question is open. */
  get showConfirm(): boolean {
    return this.#phase === "confirmThisApp" || this.#phase === "confirmAll";
  }

  /** The question is for all apps (otherwise for this app). */
  get confirmsAll(): boolean {
    return this.#phase === "confirmAll";
  }

  /** The other apps that use the person's data (what keeps the shared data when this app's is removed). */
  get otherApps(): string[] {
    return this.#apps.filter((a) => !a.isThisApp).map((a) => a.name);
  }

  /** This app's agents that another app also uses: their data stays when this app's is removed. */
  get agentsKept(): string[] {
    return planMyData(this.#apps).keptAgents;
  }

  /** The names of every app a removal of all the data affects. */
  get affectedApps(): string[] {
    return this.#apps.map((a) => a.name);
  }

  /** The question's heading; empty when none is open. */
  get confirmTitle(): string {
    const s = this.strings;
    switch (this.#phase) {
      case "confirmThisApp": return s.myDataConfirmThisAppTitle(this.appName);
      case "confirmAll": return s.myDataConfirmAllTitle;
      default: return "";
    }
  }

  /** The question's sentences, in order; empty when none is open. */
  get confirmLines(): string[] {
    const s = this.strings;
    if (this.#phase === "confirmThisApp") {
      const others = this.otherApps;
      const lines = [s.myDataConfirmThisApp(this.appName)];
      if (others.length > 0) lines.push(s.myDataConfirmKept(this.#list(others)));
      else lines.push(s.myDataConfirmNoOtherApps);
      const kept = this.agentsKept;
      if (kept.length > 0) lines.push(s.myDataConfirmAgentsKept(this.#list(kept)));
      return lines;
    }
    if (this.#phase === "confirmAll") {
      const apps = this.affectedApps;
      return [s.myDataConfirmAll, apps.length > 0 ? s.myDataConfirmAllApps(this.#list(apps)) : s.myDataConfirmAllNoApps];
    }
    return [];
  }

  /** The button that carries the removal out. */
  get confirmLabel(): string {
    return this.#phase === "confirmAll" ? this.strings.myDataConfirmRemoveAll : this.strings.myDataConfirmRemove;
  }

  get confirmName(): string {
    return this.#phase === "confirmAll" ? this.strings.myDataConfirmRemoveAllName : this.strings.myDataConfirmRemoveName;
  }

  /** The result line after an export or a removal, an error sentence after a failure, "Working…" while busy; empty otherwise. */
  get statusText(): string {
    const s = this.strings;
    if (this.#phase === "busy") return s.myDataWorking;
    switch (this.#statusKind) {
      case "exported": return s.myDataExported(this.#file);
      case "exportFailed": return s.myDataExportFailed;
      case "removeFailed": return s.myDataRemoveFailed;
      case "removedAll": return [s.myDataRemovedAll, ...this.#hostNote()].join(" ");
      case "removedThisApp": {
        const parts = [s.myDataRemoved(this.appName)];
        const deletion = this.#deletion;
        if (deletion && deletion.otherApps.length > 0) parts.push(s.myDataRemovedKept(this.#list(deletion.otherApps)));
        if (deletion && deletion.agentsKept.length > 0) parts.push(s.myDataRemovedAgentsKept(this.#list(deletion.agentsKept)));
        return [...parts, ...this.#hostNote()].join(" ");
      }
      default: return "";
    }
  }

  /** The status line is an error. */
  get isError(): boolean {
    return this.#phase === "error";
  }

  /** Asks to be told when an export has a document to save; returns the unsubscribe. The app chooses where it goes. */
  onSaveRequest(handler: (request: MyDataSaveRequest) => void): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  /** "Export my data": this app's data. */
  exportThisApp(): Promise<void> {
    return this.#export("thisApp");
  }

  /** "Export all my Fadenstack data". */
  exportAll(): Promise<void> {
    return this.#export("allApps");
  }

  /** "Remove my data…": asks first (reads the apps again, so the question names who uses what now). */
  async askRemoveThisApp(): Promise<void> {
    await this.#ask("confirmThisApp");
  }

  /** "Remove all my Fadenstack data…": asks first, with the apps it affects. */
  async askRemoveAll(): Promise<void> {
    await this.#ask("confirmAll");
  }

  /** The person said yes to the open question: removes. */
  async confirm(): Promise<void> {
    if (!this.showConfirm) return;
    const scope: DataScope = this.#phase === "confirmAll" ? "allApps" : "thisApp";
    this.#phase = "busy";
    this.notify();
    try {
      this.#deletion = await this.#source.remove(scope);
      this.#statusKind = scope === "allApps" ? "removedAll" : "removedThisApp";
      this.#phase = "done";
    } catch {
      this.#statusKind = "removeFailed"; // never the exception's text
      this.#phase = "error";
    }
    await this.#readApps();
    this.notify();
  }

  /** The person said no to the open question. */
  cancel(): void {
    if (!this.showConfirm) return;
    this.#phase = "idle";
    this.#statusKind = "none";
    this.notify();
  }

  /** The app's language changed: every text is said again. */
  retext(): void {
    this.notify();
  }

  async #ask(phase: "confirmThisApp" | "confirmAll"): Promise<void> {
    if (!this.canAct) return;
    this.#statusKind = "none";
    await this.#readApps();
    this.#phase = phase;
    this.notify();
  }

  async #export(scope: DataScope): Promise<void> {
    if (!this.canAct) return;
    this.#phase = "busy";
    this.#statusKind = "none";
    this.notify();
    try {
      const document = await this.#source.export(scope);
      const text = JSON.stringify(document, null, 2);
      const request: MyDataSaveRequest = { fileName: this.#fileName(scope), scope, content: new Blob([text], { type: "application/json" }), text };
      for (const handler of [...this.#handlers]) handler(request);
      this.#file = request.fileName;
      this.#statusKind = "exported";
      this.#phase = "done";
    } catch {
      this.#statusKind = "exportFailed"; // never the exception's text
      this.#phase = "error";
    }
    this.notify();
  }

  async #readApps(): Promise<void> {
    try {
      this.#apps = await this.#source.apps();
    } catch {
      // the list stays as it was; a question then names who is known
    }
  }

  #fileName(scope: DataScope): string {
    const day = new Date().toISOString().slice(0, 10);
    if (scope === "allApps") return `fadenstack-all-my-data-${day}.json`;
    const slug = this.appName.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") || "app";
    return `fadenstack-my-data-${slug}-${day}.json`;
  }

  /** "A, B and C" in the texts' language. */
  #list(names: readonly string[]): string {
    try {
      return new Intl.ListFormat(this.strings.language, { style: "long", type: "conjunction" }).format(names);
    } catch {
      return names.join(", ");
    }
  }

  #hostNote(): string[] {
    const deletion = this.#deletion;
    return deletion?.hostStoresLeft ? [this.strings.myDataHostStoresLeft] : [];
  }
}

function agentSource(agent: FadenstackAgent): MyDataSource {
  return {
    get appName() {
      return agent.appName;
    },
    start: () => agent.start(),
    apps: () => agent.myDataApps(),
    export: (scope) => agent.exportMyData({ scope }),
    remove: (scope) => agent.deleteMyData({ scope }),
  };
}
