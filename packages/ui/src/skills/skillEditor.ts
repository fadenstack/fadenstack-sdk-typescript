import {
  LOAD_SKILL_TOOL,
  SkillIssueCode,
  SkillLimits,
  SkillSaveStatus,
  createSkillDocument,
  skillFileText,
  skillSaveResult,
  type SkillDocument,
  type SkillFile,
  type SkillIssue,
  type SkillSaveResult,
  type SkillTestResult,
  type SkillWorkshop,
} from "@fadenstack/agents";
import type { ChatMessage, ChatOptions } from "@fadenstack/client";

import { parseMarkdown } from "../markdown/parse.js";
import type { MarkdownBlock } from "../markdown/model.js";
import { Observable } from "../observable.js";
import { englishStrings } from "../strings.js";
import {
  skillActivationLabel,
  skillIssueView,
  skillMatchLabel,
  type SkillFileHost,
  type SkillIssueView,
  type SkillModel,
  type StringsSource,
} from "./contracts.js";

/** What the editor is for. */
export const SkillEditorMode = Object.freeze({
  /** A skill that does not exist yet: a new one, or a copy. */
  New: "new",
  /** One of the person's own skills. */
  Edit: "edit",
  /** A bundled skill: read only. */
  View: "view",
  /** A model's draft: the person reads it first; it is not saved until they press Save. */
  Proposal: "proposal",
} as const);
export type SkillEditorMode = (typeof SkillEditorMode)[keyof typeof SkillEditorMode];

/** What the model would do with a prompt (the "ask the model once" step). */
export const SkillModelAnswer = Object.freeze({
  NotAsked: "notAsked",
  Asking: "asking",
  LoadsThis: "loadsThis",
  LoadsOther: "loadsOther",
  LoadsNone: "loadsNone",
  Failed: "failed",
} as const);
export type SkillModelAnswer = (typeof SkillModelAnswer)[keyof typeof SkillModelAnswer];

/** The editor was closed: by Save (`saved`) or by Cancel. */
export interface SkillEditorClosed {
  readonly saved: boolean;
  readonly name: string | undefined;
}

/** An activation the person can pick, with its words. */
export interface SkillActivationOption {
  readonly value: string;
  readonly label: string;
}

/** A file of the skill, in the editor's list. */
export class SkillResourceViewModel extends Observable {
  readonly file: SkillFile;
  readonly #owner: SkillEditorViewModel;
  #newPath: string;

  constructor(file: SkillFile, owner: SkillEditorViewModel) {
    super();
    this.file = file;
    this.#owner = owner;
    this.#newPath = file.path;
  }

  get path(): string {
    return this.file.path;
  }

  get size(): number {
    return this.file.bytes.length;
  }

  /** Text the person can read in the skill (not a picture or another binary). */
  get isText(): boolean {
    return skillFileText(this.file) !== undefined;
  }

  /** The name being typed for a rename. */
  get newPath(): string {
    return this.#newPath;
  }

  set newPath(value: string) {
    const text = value ?? "";
    if (text === this.#newPath) return;
    this.#newPath = text;
    this.notify();
  }

  get canRename(): boolean {
    return !this.#owner.isReadOnly && this.#newPath !== this.file.path;
  }

  get canRemove(): boolean {
    return !this.#owner.isReadOnly;
  }

  rename(): void {
    if (this.canRename) this.#owner.renameResource(this, this.#newPath);
  }

  remove(): void {
    if (this.canRemove) this.#owner.removeResource(this);
  }
}

export interface SkillEditorOptions {
  workshop: SkillWorkshop;
  mode: SkillEditorMode;
  document: SkillDocument;
  /** The name the skill is kept under now (for an edit): a rename removes the old one on Save. */
  originalName?: string | undefined;
  /** What reading the skill found; the errors that are about the stored skill itself stop the save. */
  readIssues?: readonly SkillIssue[] | undefined;
  files?: SkillFileHost | undefined;
  /** The model for "ask the model once" (one call, no tool runs); without it that button is off. */
  model?: SkillModel | undefined;
  strings?: StringsSource | undefined;
}

const READ_PROBLEMS: ReadonlySet<string> = new Set([
  SkillIssueCode.FileTooLarge, SkillIssueCode.TooManyFiles, SkillIssueCode.TotalTooLarge, SkillIssueCode.ReadFailed, SkillIssueCode.LinkEntry,
]);

const join = (items: readonly string[]): string => items.join(", ");

const split = (text: string): string[] => [...new Set(text.split(/[,\n\r;]/).map((p) => p.trim()).filter((p) => p.length > 0))];

const LOAD_SCHEMA = {
  type: "object",
  properties: { skillName: { type: "string", description: "The name of the skill." } },
  required: ["skillName"],
};

/**
 * The skill editor (sdk/51 F04): the name and description with the checks as you type, the instructions in Markdown with a preview,
 * the `faden.yaml` fields, the resource files, Save (on only when the checks pass), Cancel, and Test. A skill's text is untrusted
 * input, so **nothing is saved except by Save**: not a draft, not an import, not what the test step does. Test runs the module's
 * pre-selection over the edited skill and, if the app gave a model, asks it once whether it would call `load_skill`: one model call
 * with that one tool declared, and no tool runs. Platform-neutral: the skins draw it. .NET: `SkillEditorViewModel`.
 */
export class SkillEditorViewModel extends Observable {
  readonly #workshop: SkillWorkshop;
  readonly #files: SkillFileHost | undefined;
  readonly #model: SkillModel | undefined;
  readonly #strings: StringsSource;
  readonly #readIssues: readonly SkillIssue[];
  readonly #metadata: Readonly<Record<string, string>>;
  readonly #allowedTools: string;
  readonly #kept: SkillDocument["extension"];
  readonly #closed = new Set<(event: SkillEditorClosed) => void>();
  #resources: SkillFile[];
  #resourceRows: readonly SkillResourceViewModel[];
  #unknownKeys: readonly string[];
  #originalName: string | undefined;
  #mode: SkillEditorMode;
  #name: string;
  #description: string;
  #license: string;
  #compatibility: string;
  #instructions: string;
  #extensionTitle: string;
  #tagsText: string;
  #keywordsText: string;
  #fileTypesText: string;
  #preferredToolsText: string;
  #priority: number;
  #activation: string;
  #dirty: boolean;
  #saving = false;
  #needsReplace = false;
  #showPreview = false;
  #message = "";
  #saveVersion = 0;
  #askVersion = 0;
  #testVersion = 0;
  #hasErrorsFromCheck = false;
  #issues: readonly SkillIssueView[] = [];
  #testPrompt = "";
  #test: SkillTestResult | undefined;
  #answer: SkillModelAnswer = SkillModelAnswer.NotAsked;
  #answerSkill = "";
  #previewFor: string | undefined;
  #preview: readonly MarkdownBlock[] = [];
  #ask: AbortController | undefined;

  constructor(options: SkillEditorOptions) {
    super();
    const document = options.document;
    this.#workshop = options.workshop;
    this.#files = options.files;
    this.#model = options.model;
    this.#strings = options.strings ?? (() => englishStrings);
    this.#mode = options.mode;
    this.#originalName = options.originalName;
    this.#readIssues = (options.readIssues ?? []).filter((i) => i.isError && i.code !== SkillIssueCode.UnknownKey && READ_PROBLEMS.has(i.code));
    this.#name = document.name;
    this.#description = document.description;
    this.#license = document.license;
    this.#compatibility = document.compatibility;
    this.#instructions = document.instructions;
    this.#metadata = document.metadata;
    this.#allowedTools = document.allowedTools;
    this.#unknownKeys = document.unknownKeys;
    this.#kept = document.extension;
    this.#extensionTitle = document.extension.title;
    this.#tagsText = join(document.extension.tags);
    this.#keywordsText = join(document.extension.keywords);
    this.#fileTypesText = join(document.extension.fileTypes);
    this.#preferredToolsText = join(document.extension.preferredTools);
    this.#priority = document.extension.priority;
    this.#activation = document.extension.activation;
    this.#resources = [...document.resources];
    this.#resourceRows = this.#resources.map((r) => new SkillResourceViewModel(r, this));
    this.#dirty = options.mode === SkillEditorMode.Proposal;
    this.#recheck();
  }

  /** Calls `listener` when the editor is closed, by Save or by Cancel; returns the unsubscribe. */
  onClosed(listener: (event: SkillEditorClosed) => void): () => void {
    this.#closed.add(listener);
    return () => {
      this.#closed.delete(listener);
    };
  }

  get mode(): SkillEditorMode {
    return this.#mode;
  }

  get isReadOnly(): boolean {
    return this.#mode === SkillEditorMode.View;
  }

  /** A model's draft that has not been saved: the skin marks it clearly. */
  get isProposal(): boolean {
    return this.#mode === SkillEditorMode.Proposal;
  }

  /** The heading: "New skill", "Editing x", or that a bundled skill is read only. */
  get heading(): string {
    const strings = this.#strings();
    return this.#mode === SkillEditorMode.View ? strings.skillEditorReadOnly(this.#name)
      : this.#mode === SkillEditorMode.Edit ? strings.skillEditorEditing(this.#originalName ?? this.#name) : strings.skillNew;
  }

  /** For a proposal: that it is one, and that nothing is saved until Save. */
  get proposalNote(): string {
    return this.isProposal ? this.#strings().skillEditorProposal : "";
  }

  get name(): string {
    return this.#name;
  }

  set name(value: string) {
    this.#change("name", value);
  }

  get description(): string {
    return this.#description;
  }

  set description(value: string) {
    this.#change("description", value);
  }

  get license(): string {
    return this.#license;
  }

  set license(value: string) {
    this.#change("license", value);
  }

  get compatibility(): string {
    return this.#compatibility;
  }

  set compatibility(value: string) {
    this.#change("compatibility", value);
  }

  /** The instructions, Markdown. */
  get instructions(): string {
    return this.#instructions;
  }

  set instructions(value: string) {
    this.#change("instructions", value);
  }

  get extensionTitle(): string {
    return this.#extensionTitle;
  }

  set extensionTitle(value: string) {
    this.#change("extensionTitle", value);
  }

  /** One per line, or separated by commas. */
  get tagsText(): string {
    return this.#tagsText;
  }

  set tagsText(value: string) {
    this.#change("tagsText", value);
  }

  get keywordsText(): string {
    return this.#keywordsText;
  }

  set keywordsText(value: string) {
    this.#change("keywordsText", value);
  }

  get fileTypesText(): string {
    return this.#fileTypesText;
  }

  set fileTypesText(value: string) {
    this.#change("fileTypesText", value);
  }

  get preferredToolsText(): string {
    return this.#preferredToolsText;
  }

  set preferredToolsText(value: string) {
    this.#change("preferredToolsText", value);
  }

  /** 0 to 100 (the module ranks by it). */
  get priority(): number {
    return this.#priority;
  }

  set priority(value: number) {
    this.#change("priority", value);
  }

  /** `auto`, `always` or `manual`. */
  get activation(): string {
    return this.#activation;
  }

  set activation(value: string) {
    this.#change("activation", value ?? "auto");
  }

  get activationOptions(): readonly SkillActivationOption[] {
    const strings = this.#strings();
    return ["auto", "always", "manual"].map((value) => ({ value, label: skillActivationLabel(strings, value) }));
  }

  /** The files beside SKILL.md. */
  get resources(): readonly SkillResourceViewModel[] {
    return this.#resourceRows;
  }

  get hasResources(): boolean {
    return this.#resources.length > 0;
  }

  /** What the checks found (errors and warnings), as you type. */
  get issues(): readonly SkillIssueView[] {
    return this.#issues;
  }

  get hasIssues(): boolean {
    return this.#issues.length > 0;
  }

  get hasErrors(): boolean {
    return this.#hasErrorsFromCheck || this.#readIssues.length > 0;
  }

  /** Save is on only when every check passes. */
  get canSave(): boolean {
    return !this.isReadOnly && !this.hasErrors && !this.#saving;
  }

  get isDirty(): boolean {
    return this.#dirty;
  }

  get isSaving(): boolean {
    return this.#saving;
  }

  /** The name is taken by another skill: Save asks first, and replaces it only after the person confirms. */
  get needsReplaceConfirmation(): boolean {
    return this.#needsReplace;
  }

  get canConfirmReplace(): boolean {
    return this.#needsReplace && !this.#saving;
  }

  get replaceTitle(): string {
    return this.#needsReplace ? this.#strings().skillExistsTitle(this.#name) : "";
  }

  get replaceBody(): string {
    return this.#strings().skillExistsBody;
  }

  /** The frontmatter has fields beyond the six; they stop the save until removed. */
  get hasUnknownKeys(): boolean {
    return this.#unknownKeys.length > 0;
  }

  get canDropUnknownKeys(): boolean {
    return !this.isReadOnly && this.#unknownKeys.length > 0;
  }

  get canAddResource(): boolean {
    return !this.isReadOnly && this.#files !== undefined;
  }

  /** What the last action said, e.g. that the skill could not be written. */
  get message(): string {
    return this.#message;
  }

  get showPreview(): boolean {
    return this.#showPreview;
  }

  set showPreview(value: boolean) {
    if (value === this.#showPreview) return;
    this.#showPreview = value;
    this.notify();
  }

  togglePreview(): void {
    this.showPreview = !this.#showPreview;
  }

  /** The instructions as the chat's Markdown model (its blocks), when the preview is on. */
  get previewBlocks(): readonly MarkdownBlock[] {
    if (!this.#showPreview) return [];
    if (this.#previewFor !== this.#instructions) {
      this.#preview = parseMarkdown(this.#instructions);
      this.#previewFor = this.#instructions;
    }
    return this.#preview;
  }

  /** The instructions' size in tokens as the advisory limit counts them (4 characters each), for a counter under the field. */
  get instructionsTokens(): number {
    return Math.trunc(this.#instructions.length / SkillLimits.charactersPerToken);
  }

  // -- Test --------------------------------------------------------------------------------------------

  /** The message to try the pre-selection with. */
  get testPrompt(): string {
    return this.#testPrompt;
  }

  set testPrompt(value: string) {
    const text = value ?? "";
    if (text === this.#testPrompt) return;
    this.#testPrompt = text;
    this.notify();
  }

  get hasTestResult(): boolean {
    return this.#test !== undefined;
  }

  /** The skills the model is told about for the prompt. */
  get testListed(): readonly string[] {
    return this.#test?.listed ?? [];
  }

  /** The skills that matched, each with how ("named in the message", "matches its keywords", "always on"). */
  get testMatches(): readonly string[] {
    const strings = this.#strings();
    return this.#test?.matches.map((m) => `${m.name} — ${skillMatchLabel(strings, m.matchedBy)}`) ?? [];
  }

  /** The skills whose instructions are loaded without the model asking. */
  get testPreloaded(): readonly string[] {
    return this.#test?.preloaded ?? [];
  }

  /** The edited skill was listed, matched or pre-loaded. */
  get testIncludesThisSkill(): boolean {
    return this.#test?.editedListed === true;
  }

  /** What the test says in words when there is nothing to list, or when the edited skill is not offered. */
  get testNote(): string {
    const test = this.#test;
    const strings = this.#strings();
    return test === undefined ? "" : test.listed.length === 0 ? strings.skillTestNone : !test.editedListed ? strings.skillTestEditedNotListed : "";
  }

  /** The model can be asked (the app gave one). */
  get canAskModel(): boolean {
    return this.#model !== undefined;
  }

  /** The "ask the model once" button is on: a model, a message, and no answer on its way. */
  get canAsk(): boolean {
    return this.#model !== undefined && this.#testPrompt.trim().length > 0 && this.#answer !== SkillModelAnswer.Asking;
  }

  get modelAnswer(): SkillModelAnswer {
    return this.#answer;
  }

  /** The model's answer in words; empty before it was asked. */
  get modelAnswerText(): string {
    const strings = this.#strings();
    switch (this.#answer) {
      case SkillModelAnswer.Asking: return strings.skillModelAsking;
      case SkillModelAnswer.LoadsThis: return strings.skillModelWouldLoad(this.#answerSkill);
      case SkillModelAnswer.LoadsOther: return strings.skillModelWouldLoadOther(this.#answerSkill);
      case SkillModelAnswer.LoadsNone: return strings.skillModelWouldNot;
      case SkillModelAnswer.Failed: return strings.skillModelFailed;
      default: return "";
    }
  }

  get modelNote(): string {
    return this.#strings().skillModelNote;
  }

  /** The pre-selection for `testPrompt` over the edited skill and the person's others. No model, no tool. */
  async runTest(): Promise<void> {
    const version = ++this.#testVersion;
    let result: SkillTestResult | undefined;
    try {
      result = await this.#workshop.test(this.#testPrompt, this.buildDocument(), this.#originalName);
    } catch {
      result = undefined;
    }
    if (version !== this.#testVersion) return; // a newer test replaced this one
    this.#test = result;
    this.notify();
  }

  /** Asks the model once: would it call `load_skill` for the prompt, and for which skill. One call, and nothing runs. */
  async askModel(): Promise<void> {
    const model = this.#model;
    if (!model || this.#testPrompt.trim().length === 0 || this.#answer === SkillModelAnswer.Asking) return;
    const version = ++this.#askVersion;
    const prompt = this.#testPrompt;
    const name = this.#name;
    this.#setAnswer(SkillModelAnswer.Asking, "");
    await this.runTest();
    if (version !== this.#askVersion) return;
    const instructions = this.#test?.modelInstructions;
    if (instructions === undefined) {
      this.#setAnswer(SkillModelAnswer.LoadsNone, ""); // no skill is listed: there is nothing to call, so there is nothing to ask
      return;
    }
    let answer: SkillModelAnswer = SkillModelAnswer.Failed;
    let skill = "";
    const controller = new AbortController();
    this.#ask = controller;
    try {
      const messages: ChatMessage[] = [{ role: "system", content: instructions }, { role: "user", content: prompt }];
      // The one tool the model is offered, as a declaration: it cannot run, and nothing here has a call to answer.
      const options: ChatOptions = {
        tools: [{ name: LOAD_SKILL_TOOL, description: "Loads a skill's instructions.", parameters: LOAD_SCHEMA }],
        toolChoice: "auto",
        extra: { parallel_tool_calls: false },
        signal: controller.signal,
      };
      let calls = 0;
      for await (const update of model.stream(messages, options)) {
        if (update.type !== "tool_calls") continue;
        for (const call of update.calls) {
          if (call.name !== LOAD_SKILL_TOOL) continue;
          calls++;
          const argument = call.arguments?.["skillName"];
          if (skill.length === 0 && typeof argument === "string") skill = argument;
        }
      }
      answer = calls === 0 ? SkillModelAnswer.LoadsNone : skill === name ? SkillModelAnswer.LoadsThis : SkillModelAnswer.LoadsOther;
    } catch {
      answer = SkillModelAnswer.Failed;
    }
    if (version === this.#askVersion) this.#setAnswer(answer, skill);
  }

  #setAnswer(answer: SkillModelAnswer, skill: string): void {
    this.#answer = answer;
    this.#answerSkill = skill;
    this.notify();
  }

  // -- editing -----------------------------------------------------------------------------------------

  #change(field: string, value: string | number): void {
    if (this.isReadOnly) return;
    const text = typeof value === "number" ? value : value ?? "";
    switch (field) {
      case "name": if (this.#name === text) return; this.#name = text as string; break;
      case "description": if (this.#description === text) return; this.#description = text as string; break;
      case "license": if (this.#license === text) return; this.#license = text as string; break;
      case "compatibility": if (this.#compatibility === text) return; this.#compatibility = text as string; break;
      case "instructions": if (this.#instructions === text) return; this.#instructions = text as string; break;
      case "extensionTitle": if (this.#extensionTitle === text) return; this.#extensionTitle = text as string; break;
      case "tagsText": if (this.#tagsText === text) return; this.#tagsText = text as string; break;
      case "keywordsText": if (this.#keywordsText === text) return; this.#keywordsText = text as string; break;
      case "fileTypesText": if (this.#fileTypesText === text) return; this.#fileTypesText = text as string; break;
      case "preferredToolsText": if (this.#preferredToolsText === text) return; this.#preferredToolsText = text as string; break;
      case "priority": if (this.#priority === text) return; this.#priority = text as number; break;
      case "activation": if (this.#activation === text) return; this.#activation = text as string; break;
      default: return;
    }
    this.#dirty = true;
    this.#recheck();
  }

  /** The skill as the fields now say it. */
  buildDocument(): SkillDocument {
    return createSkillDocument({
      name: this.#name.trim(),
      description: this.#description.trim(),
      license: this.#license.trim(),
      compatibility: this.#compatibility.trim(),
      metadata: this.#metadata,
      allowedTools: this.#allowedTools,
      instructions: this.#instructions,
      unknownKeys: this.#unknownKeys,
      resources: [...this.#resources],
      extension: {
        ...this.#kept,
        title: this.#extensionTitle.trim(),
        tags: split(this.#tagsText),
        keywords: split(this.#keywordsText),
        fileTypes: split(this.#fileTypesText),
        preferredTools: split(this.#preferredToolsText),
        priority: this.#priority,
        activation: this.#activation,
      },
    });
  }

  #recheck(): void {
    const check = this.#workshop.check(this.buildDocument());
    this.#hasErrorsFromCheck = check.hasErrors;
    const strings = this.#strings();
    const all = [...this.#readIssues, ...check.issues];
    // errors first, each group in the order the checks found them
    this.#issues = [...all.filter((i) => i.isError), ...all.filter((i) => !i.isError)].map((i) => skillIssueView(i, strings));
    if (this.#needsReplace) this.#needsReplace = false; // the name changed: ask again at the next Save
    this.notify();
  }

  /** The app's language changed: the texts are said in the new one. */
  retext(): void {
    this.#recheck();
  }

  /** Removes the fields beyond the six from the document (they are gone from the next Save). */
  dropUnknownKeys(): void {
    if (!this.canDropUnknownKeys) return;
    this.#unknownKeys = [];
    this.#dirty = true;
    this.#recheck();
  }

  // -- the files ---------------------------------------------------------------------------------------

  /** Asks the app for a file and adds it. */
  async addResourceFromHost(): Promise<void> {
    const files = this.#files;
    if (!files || this.isReadOnly) return;
    let file: SkillFile | undefined;
    try {
      file = await files.pickResource();
    } catch {
      file = undefined;
    }
    if (file) this.addResource(file);
  }

  /** Adds a file (one with the same path is replaced). Whether its path and kind are allowed is for the checks. */
  addResource(file: SkillFile): void {
    if (this.isReadOnly || !file) return;
    const normalized: SkillFile = { path: (file.path ?? "").replaceAll("\\", "/"), bytes: file.bytes };
    const existing = this.#resources.findIndex((r) => r.path.toLowerCase() === normalized.path.toLowerCase());
    if (existing >= 0) this.#resources[existing] = normalized;
    else this.#resources.push(normalized);
    this.#resourcesChanged();
  }

  renameResource(row: SkillResourceViewModel, newPath: string): void {
    const index = this.#resources.indexOf(row.file);
    if (this.isReadOnly || index < 0) return;
    this.#resources[index] = { path: (newPath ?? "").trim().replaceAll("\\", "/"), bytes: row.file.bytes };
    this.#resourcesChanged();
  }

  removeResource(row: SkillResourceViewModel): void {
    const index = this.#resources.indexOf(row.file);
    if (this.isReadOnly || index < 0) return;
    this.#resources.splice(index, 1);
    this.#resourcesChanged();
  }

  #resourcesChanged(): void {
    this.#resourceRows = this.#resources.map((r) => new SkillResourceViewModel(r, this));
    this.#dirty = true;
    this.#recheck();
  }

  // -- Save and Cancel ---------------------------------------------------------------------------------

  /** Saves the skill. Only the person's Save (or confirming a replacement) calls this; nothing else here ever writes. */
  async save(): Promise<void> {
    return this.#save(false);
  }

  /** The person confirmed replacing the skill of this name. */
  async confirmReplace(): Promise<void> {
    if (!this.canConfirmReplace) return;
    return this.#save(true);
  }

  dismissReplace(): void {
    if (!this.#needsReplace) return;
    this.#needsReplace = false;
    this.notify();
  }

  async #save(replace: boolean): Promise<void> {
    if (this.isReadOnly || this.hasErrors || this.#saving) return;
    const document = this.buildDocument();
    const version = ++this.#saveVersion;
    this.#saving = true;
    this.#needsReplace = false;
    this.#message = "";
    this.notify();
    let result: SkillSaveResult;
    try {
      // Only here, because the person pressed Save (or confirmed the replacement).
      result = await this.#workshop.save(document, this.#originalName, replace);
    } catch {
      result = skillSaveResult(SkillSaveStatus.Failed, [], document.name);
    }
    if (version !== this.#saveVersion) return;
    this.#saving = false;
    switch (result.status) {
      case SkillSaveStatus.Saved:
        this.#originalName = document.name;
        this.#mode = SkillEditorMode.Edit;
        this.#dirty = false;
        this.#message = this.#strings().skillSaved(document.name);
        this.notify();
        for (const listener of [...this.#closed]) listener({ saved: true, name: document.name });
        return;
      case SkillSaveStatus.Exists:
        this.#needsReplace = true;
        this.notify();
        return;
      case SkillSaveStatus.Refused:
        this.#recheck();
        return;
      default:
        this.#message = this.#strings().skillSaveFailed;
        this.notify();
    }
  }

  /** Closes the editor without saving. */
  cancel(): void {
    this.#saveVersion++; // a save still running no longer closes anything
    this.#askVersion++;
    this.#ask?.abort();
    for (const listener of [...this.#closed]) listener({ saved: false, name: undefined });
  }
}
