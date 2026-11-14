import type { ReasoningLevel, SkillIssueCode } from "@fadenstack/agents";
import type { EndpointProblem, TextWatermark, ToolClass, ToolMode } from "@fadenstack/client";

import type { PasswordFailure, StartFailure } from "./wizard/contracts.js";

/**
 * Every text the chat shows, in one place, so skins hard-code none: a host passes a language (`stringsFor`, or its
 * own translation) or its own words through `AgentChatOptions.strings`. English by default.
 */
export interface UiStrings {
  // the language
  /** The BCP 47 tag of these texts ("de", "zh-Hans"): skins set it as the panel's `lang`. */
  language: string;
  /** Which way these texts run: skins set it as the panel's `dir`. */
  direction: "ltr" | "rtl";
  /** The language's name in itself ("Deutsch"): the settings list each language by it, so anyone finds their own. */
  languageName: string;
  // the turn
  working: string;
  /** The turn's line while the host's turn gate holds it back (.NET `WaitingForSlot`). */
  waitingForSlot: string;
  stopped: string;
  failed: string;
  tokens(count: string): string;
  notAttached(title: string): string;
  // tools
  toolRunning(name: string): string;
  toolWaiting(name: string): string;
  toolRan(name: string): string;
  toolFailed(name: string): string;
  toolDenied(name: string): string;
  toolStopped(name: string): string;
  toolClass: Record<ToolClass, string>;
  moreCharacters(count: string): string;
  // approvals
  approvalTitle(name: string): string;
  approvalClass: Record<ToolClass, string>;
  /** Why a host tool asks, by its class (a gateway tool says why itself: the admin's message). */
  approvalWhy: Record<ToolClass, string>;
  serverTool: string;
  /** The badge, and why it asks, for a tool that reaches outside the organisation (a web search, opening a page). */
  approvalOutside: string;
  approvalOutsideWhy: string;
  /** The source line of a card for a local MCP server's tool: "From Files, an MCP server on this computer". */
  approvalFromMcp(server: string): string;
  /** Why a card asks about a local MCP server's tool nobody classified. */
  approvalUnchecked: string;
  /** What the server's own annotations say, after `approvalUnchecked`. */
  approvalServerReadOnly: string;
  approvalServerDestructive: string;
  /** The switch of a `markdown` fence between its rendered content and its source. */
  markdownPreview: string;
  markdownSource: string;
  /** The label of a diagram in text form (a `mermaid` fence), which is not drawn. */
  diagramMermaid: string;
  allow: string;
  allowForChat: string;
  allowAlways: string;
  allowForTime(minutes: number): string;
  allowedForTime(minutes: number): string;
  confirmingGrant: string;
  timeGrantHint: string;
  deny: string;
  allowed: string;
  allowedForChat: string;
  allowedAlways: string;
  /** The tool-mode menu's item that forgets what was allowed for this chat and always. */
  resetApprovals: string;
  denied: string;
  noAnswer: string;
  // notices
  noticeTitles: Record<string, string>;
  noticeFallback: string;
  tryAgainIn(seconds: number): string;
  decision(id: string): string;
  piiTitle: string;
  piiMessage(total: number, list: string): string;
  /** The notice for an answer without a machine-readable AI mark (`faden.unmarked`), shown only when the person turned it on. */
  unmarkedTitle: string;
  unmarkedMessage: string;
  /** The settings item that turns that notice on; its accessible name. */
  settingsUnmarked: string;
  /** A model call ended with no text and no tool call (`empty_answer`): what the notice says, and that Retry may help. */
  emptyAnswer: string;
  /** The same when the model ran out of tokens first (`empty_answer`, `length`), often while thinking. */
  emptyAnswerLength: string;
  // reasoning and references
  thinking: string;
  thoughtFor(seconds: number): string;
  usedReferences(count: number): string;
  part(number: number): string;
  /** A reference without a name. */
  source: string;
  // the chat
  greetingFallback(agent: string): string;
  newChat: string;
  yesterday: string;
  /** The tool modes a person sees; Bypass is switched on only with its own confirmation (`bypassTitle`...). */
  modes: Record<ToolMode, { label: string; description: string }>;
  limitedTo(description: string, mode: string): string;
  // the settings menu
  settings: string;
  /** The heading of the languages in the settings. */
  languageMenu: string;
  /** "Automatic (English)": follow the host's language, named in it. */
  languageAutomatic(name: string): string;
  /** Under the languages when the organisation fixed one. */
  languageLocked: string;
  // About (the settings' last item); the brand name is never a text here, it is not translated
  /** The settings' last item, and the name of what it opens. */
  about: string;
  /** The agent's published version. */
  aboutVersion(version: number): string;
  /** An agent that is a maintainer's draft, not a published version. */
  aboutDraft: string;
  aboutModel(model: string): string;
  /** The app the agent runs in, as the host described it: "Word add-in 1.4". */
  aboutApp(app: string): string;
  /** The server's address: shown, never sent. */
  aboutServer(address: string): string;
  /** The link to the organisation's own Help, on its server. */
  help: string;
  /** The link to the SDKs' documentation. */
  developerDocs: string;
  copyDetails: string;
  /** After a link's name, for screen readers: the panel's links open in a new tab. */
  opensInNewTab: string;
  close: string;
  // the skin's controls
  send: string;
  stop: string;
  history: string;
  noHistory: string;
  deleteSession: string;
  toolMode: string;
  /** The thinking pill's menu: its caption and the pill's name for screen readers (.NET `ReasoningMenu`). */
  reasoningMenu: string;
  /** "Thinking: Low": the pill in full, for `level` as its label says it (.NET `ReasoningPill`). */
  reasoningPill(level: string): string;
  /** A level's name in the pill and its menu (.NET `Reasoning_<Level>_Label`). */
  reasoningLabel: Record<ReasoningLevel, string>;
  /** What a level means, in one line (.NET `Reasoning_<Level>_Description`). */
  reasoningDescription: Record<ReasoningLevel, string>;
  showEarlier: string;
  copy: string;
  copyCode: string;
  copyTable: string;
  copied: string;
  edit: string;
  editAndResend: string;
  retry: string;
  notSent: string;
  composerPlaceholder: string;
  /**
   * Under the message box: that the answers come from an AI and can be wrong (the EU AI Act asks that people know
   * they deal with an AI). Empty hides it, for a host that says so in another place the user always sees.
   */
  aiNotice: string;
  removeAttachment: string;
  includeAttachment: string;
  arguments: string;
  result: string;
  /** In place of a picture in an answer, which is never loaded: "[image]" without its alt text. */
  image: string;
  // skills ($ or / in the composer)
  /** The skill picker's name, and the second line of a picked skill's chip. */
  skills: string;
  skill: string;
  skillsLoading: string;
  noSkills: string;
  noSkillMatches(query: string): string;
  skillsFailed: string;
  /** Under the picker: how to use it. */
  skillPickerHint: string;
  // pictures
  /** The second line of a picture's chip. */
  picture: string;
  /** A pasted picture's name. */
  pastedPicture: string;
  /** Said when a picture is added for an agent whose model does not see pictures. */
  picturesNotSeen: string;
  pictureNotRead(name: string): string;
  // content made with AI, where an agent places it (@fadenstack/provenance)
  // approvals that last: grants, Bypass, Settings -> Approvals
  /** Why a card asks although the user let the agent work in a place: a link (a symbolic link, a junction) leads out of it; realPlace is where it really leads. */
  approvalLeadsOutside(realPlace: string): string;
  /** A card's button, read out by screen readers. */
  allowMore: string;
  /** The tooltip of Reset approvals. */
  resetApprovalsHint: string;
  /** A call let through by a running approval, without asking. */
  allowedByGrant: string;
  /** A duration in minutes. */
  durationMinutes(minutes: number): string;
  /** A duration in whole hours. */
  durationHours(hours: number): string;
  /** A duration in hours and minutes. */
  durationHoursMinutes(hours: number, minutes: number): string;
  /** The question of the card that lets the agent work for a while without asking. */
  grantTitle: string;
  /** The card that extends a running approval. */
  grantExtendTitle: string;
  /** The label of the card's time picker. */
  grantDuration: string;
  /** Before the list of places on the card. */
  grantPlaces: string;
  /** Before the places an extension adds. */
  grantNewPlaces: string;
  /** An extension's time; time: e.g. 30 min. */
  grantMoreTime(time: string): string;
  /** What the agent may do without asking inside the approval, by what it was given (read, write, read_write). */
  grantMay: Record<"read" | "write" | "read_write", string>;
  /** What still asks inside the approval. */
  grantStillAsks: string;
  /** The card's button. */
  grantAllow: string;
  /** The card's button. */
  grantNotNow: string;
  /** A place's button: take it out. */
  grantRemovePlace: string;
  /** A place's button: put it back. */
  grantKeepPlace: string;
  /** The card once allowed. */
  grantAllowed: string;
  /** The card once declined. */
  grantDeclined: string;
  /** The card when the server refused or could not be reached. */
  grantFailed: string;
  /** The marker in the chat header; left: the time left. */
  markerWorking(left: string): string;
  /** The marker while the person is away. */
  markerPaused: string;
  /** The marker's button: ends the approval and what the agent is doing. */
  markerStop: string;
  /** The marker's button near the end; time: e.g. 30 min. */
  markerKeepGoing(time: string): string;
  /** A Settings section: what was allowed for longer than one call. */
  settingsApprovals: string;
  /** The Settings section when it is empty. */
  settingsApprovalsEmpty: string;
  /** tool: the tool; left: the time left. */
  settingsGrantTime(tool: string, left: string): string;
  /** places: the places; left: the time left. */
  settingsGrantWork(places: string, left: string): string;
  /** tool: the tool allowed always on this device. */
  settingsAlways(tool: string): string;
  /** A button in Settings: end an approval. */
  revoke: string;
  /** The question of the Bypass confirmation. */
  bypassTitle: string;
  /** What Bypass stops asking. */
  bypassNoLongerAsks: string;
  /** What still asks under Bypass. */
  bypassStillAsks: string;
  /** What the server records under Bypass, by level (decisions: which tool, when, where; calls: plus the arguments; results: plus a result summary). */
  bypassRecords: Record<"decisions" | "calls" | "results", string>;
  /** Under the time picker of the Bypass confirmation. */
  bypassNoExtension: string;
  /** The label of the reason box on the Bypass confirmation. */
  bypassReason: string;
  /** Under the reason box. */
  bypassReasonSeen: string;
  /** The Bypass confirmation's button that switches it on. */
  bypassAllow: string;
  /** The confirmation after the click, before the server answered. */
  bypassConfirming: string;
  /** The confirmation once the server confirmed it. */
  bypassOn: string;
  /** The server gave no acknowledgement. */
  bypassNotConfirmedUnknown: string;
  /** Why Bypass did not switch on: the server refused it, was offline, could not check its limits, or the second sign-in was denied, timed out or could not open the browser. */
  bypassNotConfirmed: Record<"refused" | "offline" | "unavailable" | "denied" | "timed_out" | "no_browser", string>;
  /** The Bypass marker; left: the time left. */
  bypassMarker(left: string): string;
  /** The Bypass marker's second line, by record level (decisions, calls, results). */
  bypassRecorded: Record<"decisions" | "calls" | "results", string>;
  /** The marker's Stop button, for screen readers. */
  bypassStopName: string;
  /** The Bypass confirmation while the second sign-in runs in the browser. */
  bypassSignIn: string;
  /** Under it; code: the code the page shows, to compare. */
  bypassSignInCode(code: string): string;
  /** Button on the Bypass confirmation: opens the sign-in page in the browser again. */
  bypassOpenAgain: string;
  /** The same button, for screen readers. */
  bypassOpenAgainName: string;
  /** Button on the line that says Bypass ended: asks for Bypass again. */
  bypassSwitchOnAgain: string;
  /** The same button, for screen readers. */
  bypassSwitchOnAgainName: string;
  /** In the chat list: a chat that runs in Bypass; left: the time left. */
  bypassListMarker(left: string): string;
  /** Bypass ended and the server did not say why. */
  bypassEndedUnknown: string;
  /** Why Bypass ended, by who or what ended it (the fallback is bypassEndedUnknown). */
  bypassEnded: Record<"person" | "expired" | "admin" | "kill_switch" | "limit" | "spent", string>;
  /** A running Bypass in Settings; left: the time left; recorded: what is recorded. */
  settingsGrantBypass(left: string, recorded: string): string;
  /** description: the mode's description; mode: the agent's highest mode. */
  limitedByAgent(description: string, mode: string): string;
  /** A marker with several grants running; count: how many; first: the time left of the one ending first. */
  grantsMarkerMany(count: number, first: string): string;
  /** A grant's time left in a marker's line; time: the time. */
  grantsLeft(time: string): string;
  /** A paused grant in a marker's line. */
  grantsPaused: string;
  /** The avatar's badge while the grant is paused. */
  grantsBadgePaused: string;
  /** The marker of a single Bypass that is paused. */
  grantsBypassPaused: string;
  /** What a stretch of work is called in a marker's line. */
  grantsKindWork: string;
  /** A grant's chat when the app cannot name it. */
  grantsChatUnknown: string;
  /** Said when Stop could not end every grant. */
  grantsStopFailed: string;
  /** Said when more time was refused or not reached. */
  grantsExtendFailed: string;
  /** Said when the server refuses more time: the grant is at its longest. */
  grantsAtLongest: string;
  /** Said while a paused grant waits for the server. */
  grantsWaiting: string;
  /** The summary of a stretch of work; time: how long it ran. */
  grantsSummaryWork(time: string): string;
  /** The summary of a Bypass; time: how long it ran. */
  grantsSummaryBypass(time: string): string;
  /** A summary's places; places: the places. */
  grantsSummaryPlaces(places: string): string;
  /** A summary's calls; count: how many ran without asking. */
  grantsSummaryCalls(count: number): string;
  /** Why a grant ended, by reason (time, stopped, elsewhere, spent, locked, away, admin, kill_switch, limit, host). */
  grantsEnded: Record<"time" | "stopped" | "elsewhere" | "spent" | "locked" | "away" | "admin" | "kill_switch" | "limit" | "host", string>;
  // saving files
  /** The button beside "Copy table": saves the table as a CSV file. */
  downloadCsv: string;
  // exporting a chat
  /** The settings item that saves the open chat as a Markdown file. */
  exportChat: string;
  /** The heading of an exported chat that has no title. */
  exportChatTitle: string;
  /** The label over the person's message in an exported chat. */
  exportYou: string;
  /** Under a message in an exported chat: the skills that went with it; list: their names. */
  exportSkills(list: string): string;
  /** Under a message in an exported chat: the attachments that went with it; list: their titles. */
  exportAttachments(list: string): string;
  // my prompts (in the skill picker, saved from a sent message)
  /** The picker's section of the user's own saved prompts. */
  myPrompts: string;
  /** The picker's section of the organisation's skills, when it also shows prompts. */
  organisationSkills: string;
  /** The picker's name for screen readers when it lists prompts and skills. */
  promptsAndSkills: string;
  /** Said under "My prompts" while none is saved. */
  noPrompts: string;
  noPromptMatches(query: string): string;
  /** Under the picker when it lists prompts. */
  promptPickerHint: string;
  /** The small button on a saved prompt: removes it from the list without using it. */
  deletePrompt: string;
  /** The button on a sent message: keeps its text as a prompt. */
  savePrompt: string;
  promptSaved: string;
  /** Said when a prompt is longer than allowed; max: the most characters. */
  promptTooLong(max: string): string;
  /** Said when the user already keeps the most prompts; max: how many. */
  promptsFull(max: string): string;
  promptNotSaved: string;
  // what the agent can use (settings -> Tools)
  /** The settings item, and the name of the view it opens. */
  tools: string;
  /** The section of the tools the app itself provides. */
  toolsInApp: string;
  /** The section of the tools the organisation's server offers this agent. */
  toolsFromServer: string;
  /** Said under "In this app" when the app brings no tools. */
  toolsNoneInApp: string;
  toolsLoading: string;
  /** Said under the server's section when it lists nothing (or an older server cannot list). */
  toolsNone: string;
  toolsFailed: string;
  /** A server tool this agent can use now. */
  toolStatusAvailable: string;
  /** A server tool an administrator switched off. */
  toolStatusDisabled: string;
  /** A server tool the agent's rules do not allow. */
  toolStatusNotAllowed: string;
  // the connection wizard (sdk/51 F15)
  wizardBack: string;
  wizardContinue: string;
  wizardCancel: string;
  wizardClose: string;
  wizardTryAgain: string;
  wizardCheck: string;
  wizardChooseTitle(app: string): string;
  wizardChooseServer: string;
  wizardChooseServerHelp: string;
  wizardChooseOwnAi: string;
  wizardChooseOwnAiHelp: string;
  wizardChooseDemo: string;
  wizardNothingAllowed: string;
  wizardAppStepRefused: string;
  wizardStoreFailed: string;
  wizardServerTitle: string;
  wizardServerLabel: string;
  wizardServerPlaceholder: string;
  wizardServerHelp: string;
  wizardServerLocked: string;
  wizardServerAddressInvalid: string;
  wizardServerHttpsRequired: string;
  wizardChecking: string;
  wizardUnreachable: string;
  wizardCertificateNotTrusted: string;
  wizardNotFadenstack: string;
  wizardRestarting(server: string): string;
  wizardChangeServer: string;
  wizardServerAt(server: string): string;
  wizardStarting: string;
  wizardCodeTitle(app: string): string;
  wizardCodeIntro: string;
  wizardCodeName: string;
  wizardCopyCode: string;
  wizardOpenPage: string;
  wizardWaiting(leftMs: number): string;
  wizardWaitingRetry(leftMs: number): string;
  wizardDenied: string;
  wizardExpired: string;
  wizardNewCode: string;
  wizardTooOld: string;
  wizardTooOldPassword: string;
  /** Why the first pairing request failed. */
  wizardStartFailure: Record<StartFailure, string>;
  wizardPairFailed: string;
  wizardRedeeming: string;
  wizardSignedInAs(person: string): string;
  wizardSignedIn: string;
  wizardNoAccess: string;
  wizardSignInEnded: string;
  wizardUsePassword: string;
  wizardEmail: string;
  wizardPassword: string;
  wizardSignIn: string;
  wizardBackToCode: string;
  /** Why the password sign-in failed. */
  wizardPasswordFailure: Record<PasswordFailure, string>;
  wizardOwnTitle: string;
  wizardOwnDataFlow: string;
  wizardOwnProviderTerms: string;
  /** The standalone notice (F15, owner 14 Nov): the report's draft without pictures (D17). Counsel reviews; German is binding. */
  wizardOwnNotice: string;
  /** The liability sentence (F15): counsel reviews; German is binding. */
  wizardOwnLiability: string;
  wizardOwnBindingVersion: string;
  wizardOwnFullTerms: string;
  wizardOwnConsent: string;
  wizardOwnSearchConsent: string;
  wizardOwnAccept: string;
  wizardOwnServerInstead: string;
  wizardOwnSearching: string;
  wizardOwnPickTitle: string;
  wizardOwnFound: string;
  wizardOwnNothingFound: string;
  wizardOwnPresets: string;
  wizardOwnAddress: string;
  wizardOwnAddressPlaceholder: string;
  wizardOwnNeedsKey: string;
  wizardOwnUse: string;
  wizardEndpointAddressInvalid: string;
  wizardEndpointHttpsRequired: string;
  wizardAddressNotAllowed: string;
  wizardAddressPlainHttpForbidden: string;
  wizardAddressKeyNeedsHttps: string;
  wizardPlainHttpTitle: string;
  wizardPlainHttpWarning: string;
  wizardPlainHttpConfirm: string;
  wizardKeyTitle: string;
  wizardKeyLabel: string;
  wizardKeyHelp: string;
  wizardOwnChecking: string;
  /** What the endpoint check found, in plain words. */
  wizardProblem: Record<EndpointProblem, string>;
  wizardEnterKey: string;
  wizardShowHelp: string;
  wizardOwnHelpTitle: string;
  wizardOwnHelp: string;
  wizardOwnWorks: string;
  /** Whether the connection watermarks text (F03 item 8). */
  wizardWatermark: Record<TextWatermark, string>;
  wizardWatermarkConfirmed: string;
  wizardModelTitle: string;
  wizardModelLabel: string;
  wizardOwnDone: string;
  wizardSettingsTitle: string;
  wizardConnectedServer(server: string): string;
  wizardConnectedEndpoint(endpoint: string): string;
  wizardConnectOrganisation: string;
  wizardChangeEndpoint: string;
  wizardSignOut: string;
  wizardRemoveEndpoint: string;
  wizardSignOutTitle: string;
  wizardSignOutBody: string;
  wizardRemoveTitle: string;
  wizardRemoveBody: string;
  wizardDeleteChats: string;
  // the skill library, the editor and "Draft from this chat" (sdk/51 F04)
  skillLibraryTitle: string;
  skillLibraryLoading: string;
  skillLibraryFailed: string;
  skillLibraryEmpty: string;
  skillOriginBundled: string;
  skillOriginOwn: string;
  skillOriginOrganisation: string;
  skillNotReviewed: string;
  skillOn: string;
  skillOff: string;
  skillNew: string;
  skillEdit: string;
  skillView: string;
  skillDuplicate: string;
  skillDelete: string;
  skillImport: string;
  skillExport: string;
  skillCancel: string;
  skillSave: string;
  skillReplace: string;
  skillDeleteTitle(name: string): string;
  skillDeleteBody: string;
  skillImportTitle(name: string): string;
  skillImportBody: string;
  skillImportReplaceBody(name: string): string;
  skillImportRefused: string;
  skillImported(name: string): string;
  skillSaved(name: string): string;
  skillDeleted(name: string): string;
  skillExported(name: string): string;
  skillExportFailed(name: string): string;
  skillSaveFailed: string;
  skillExistsTitle(name: string): string;
  skillExistsBody: string;
  skillEditorEditing(name: string): string;
  skillEditorReadOnly(name: string): string;
  skillEditorProposal: string;
  skillName: string;
  skillDescription: string;
  skillInstructions: string;
  skillPreview: string;
  skillLicense: string;
  skillCompatibility: string;
  skillMatching: string;
  skillTitleField: string;
  skillTags: string;
  skillKeywords: string;
  skillFileTypes: string;
  skillPreferredTools: string;
  skillPriority: string;
  skillActivation: string;
  skillActivationAuto: string;
  skillActivationAlways: string;
  skillActivationManual: string;
  skillResources: string;
  skillNoResources: string;
  skillAddFile: string;
  skillRenameFile: string;
  skillRemoveFile: string;
  skillDropUnknownKeys: string;
  skillChecksHeading: string;
  skillChecksOk: string;
  skillTestHeading: string;
  skillTestPrompt: string;
  skillTestRun: string;
  skillTestListed: string;
  skillTestPreloaded: string;
  skillTestNone: string;
  skillTestEditedNotListed: string;
  skillMatchExplicit: string;
  skillMatchAlways: string;
  skillMatchTrigger: string;
  skillAskModel: string;
  skillModelNote: string;
  skillModelAsking: string;
  skillModelWouldLoad(name: string): string;
  skillModelWouldLoadOther(name: string): string;
  skillModelWouldNot: string;
  skillModelFailed: string;
  skillDraftTitle: string;
  skillDraftGuidance: string;
  skillDraftStart: string;
  skillDraftWorking: string;
  skillDraftReady: string;
  skillDraftNoChat: string;
  skillDraftNoModel: string;
  skillDraftFailed: string;
  skillDraftUnreadable: string;
  skillDraftBroken: string;
  /** What a check found, in words, by its code: `{0}` the field or file, `{1}` the limit, `{2}` the size, `{3}` the detail (`skillIssueText` fills it). */
  skillIssue: Record<SkillIssueCode, string>;
}

export const englishStrings: UiStrings = {
  language: "en",
  direction: "ltr",
  languageName: "English",
  working: "Working...",
  waitingForSlot: "Waiting for a free slot",
  stopped: "Stopped",
  failed: "Something went wrong",
  tokens: (count) => `${count} tokens`,
  notAttached: (title) => `${title} was not attached`,
  toolRunning: (name) => `Running ${name}`,
  toolWaiting: (name) => `${name} is waiting for your approval`,
  toolRan: (name) => `Ran ${name}`,
  toolFailed: (name) => `${name} failed`,
  toolDenied: (name) => `${name} was not run`,
  toolStopped: (name) => `${name} was stopped`,
  toolClass: { read: "Read", write: "Write", destructive: "Destructive", unknown: "Unclassified" },
  moreCharacters: (count) => `... (${count} more characters)`,
  approvalTitle: (name) => `Run ${name}?`,
  approvalClass: { read: "Read", write: "Changes data", destructive: "Cannot be undone", unknown: "Unclassified" },
  approvalWhy: {
    read: "It only reads.",
    write: "It changes something, which can be changed back.",
    destructive: "It may do something that cannot be undone.",
    unknown: "Nobody has said what this tool does.",
  },
  serverTool: "Server tool",
  approvalOutside: "Goes outside",
  approvalOutsideWhy: "What it is given leaves your organisation: it goes to another site.",
  approvalFromMcp: (server) => `From ${server}, an MCP server on this computer`,
  approvalUnchecked: "Your organisation has not checked this tool.",
  approvalServerReadOnly: "The server says it only reads.",
  approvalServerDestructive: "The server says it may delete or overwrite.",
  markdownPreview: "Preview",
  markdownSource: "Source",
  diagramMermaid: "Diagram · Mermaid",
  allow: "Allow",
  allowForChat: "Allow for this chat",
  allowAlways: "Allow always",
  allowForTime: minutes => `Allow for ${minutes} min`,
  allowedForTime: minutes => `Server confirmed up to ${minutes} min`,
  confirmingGrant: "Confirming permission with the server…",
  timeGrantHint: "For a time allows this tool in your chats on this device until it expires. Native permissions and administrator rules still apply.",
  deny: "Deny",
  allowed: "Allowed",
  allowedForChat: "Allowed for this chat",
  allowedAlways: "Allowed always",
  resetApprovals: "Reset approvals",
  denied: "Denied",
  noAnswer: "No answer in time",
  noticeTitles: {
    prompt_blocked: "Your message was not sent",
    response_blocked: "The answer was stopped",
    tool_denied: "A tool was not allowed",
    rate_limited: "Too many requests",
    round_limit: "Stopped",
    provenance_refused: "Not written: it could not be marked as AI-generated",
    empty_answer: "No answer came back",
    grant_failed: "Allowed this time only: the server did not confirm the longer approval",
  },
  noticeFallback: "Notice",
  tryAgainIn: (seconds) => `Try again in ${seconds} s.`,
  decision: (id) => `Decision ${id}`,
  piiTitle: "Personal data protected",
  piiMessage: (total, list) => `${total} value${total === 1 ? "" : "s"} kept from the model: ${list}`,
  unmarkedTitle: "Answer without an AI mark",
  unmarkedMessage: "This answer carries no machine-readable AI mark. Your organisation allowed this model to answer without one.",
  settingsUnmarked: "Tell me when an answer carries no AI mark",
  emptyAnswer: "The model ended without writing an answer. You can try again.",
  emptyAnswerLength: "The model reached its length limit before it wrote an answer, for example while thinking. You can try again.",
  thinking: "Thinking...",
  thoughtFor: (seconds) => `Thought for ${seconds} s`,
  usedReferences: (count) => (count === 1 ? "Used 1 reference" : `Used ${count} references`),
  part: (n) => `Part ${n}`,
  source: "Source",
  greetingFallback: (agent) => `Ask ${agent} anything.`,
  newChat: "New chat",
  yesterday: "Yesterday",
  modes: {
    off: { label: "Off", description: "No tools: the agent only answers." },
    read_only: { label: "Read only", description: "Only tools that change nothing." },
    ask: { label: "Ask", description: "Asks before anything that changes something." },
    auto: { label: "Auto", description: "Runs tools that change things; still asks before anything that cannot be undone." },
    bypass: { label: "Bypass", description: "Runs every tool without asking in this chat, for a while, where your organisation allows it; rules and tools that always ask still ask, and every call is recorded." },
  },
  limitedTo: (description, mode) => `${description} Limited to ${mode} by your organisation.`,
  settings: "Settings",
  languageMenu: "Language",
  languageAutomatic: (name) => `Automatic (${name})`,
  languageLocked: "Set by your organisation",
  about: "About",
  aboutVersion: (version) => `Version ${version}`,
  aboutDraft: "Draft",
  aboutModel: (model) => `Model: ${model}`,
  aboutApp: (app) => `Runs in ${app}`,
  aboutServer: (address) => `Server: ${address}`,
  help: "Help",
  developerDocs: "Developer docs",
  copyDetails: "Copy details",
  opensInNewTab: "(opens in a new tab)",
  close: "Close",
  send: "Send",
  stop: "Stop",
  history: "Chat history",
  noHistory: "No chats yet.",
  deleteSession: "Delete chat",
  toolMode: "Tool mode",
  reasoningMenu: "How long it thinks",
  reasoningPill: (level) => `Thinking: ${level}`,
  reasoningLabel: { auto: "Auto", off: "Off", low: "Low", medium: "Medium", high: "High" },
  reasoningDescription: {
    auto: "The agent's own setting.",
    off: "Answers at once.",
    low: "Thinks briefly.",
    medium: "Thinks for a while.",
    high: "Thinks longest.",
  },
  showEarlier: "Show earlier messages",
  copy: "Copy",
  copyCode: "Copy code",
  copyTable: "Copy table",
  copied: "Copied",
  edit: "Edit",
  editAndResend: "Edit and resend",
  retry: "Retry",
  notSent: "Not sent",
  composerPlaceholder: "Ask anything",
  aiNotice: "Answers are generated by AI and can be wrong. Check what matters.",
  removeAttachment: "Remove",
  includeAttachment: "Include in the next message",
  arguments: "Input",
  result: "Output",
  image: "image",
  skills: "Skills",
  skill: "Skill",
  skillsLoading: "Loading skills...",
  noSkills: "No skills are available to you.",
  noSkillMatches: (query) => `No skill matches "${query}".`,
  skillsFailed: "The skills could not be loaded.",
  skillPickerHint: "Enter picks the skill, Esc closes the list.",
  picture: "Picture",
  pastedPicture: "Pasted picture",
  picturesNotSeen: "This agent's model does not see pictures.",
  pictureNotRead: (name) => `${name} could not be read as a picture.`,
  approvalLeadsOutside: (realPlace) => `This path leads through a link outside the places you let it work in: to ${realPlace}.`,
  allowMore: "More ways to allow",
  resetApprovalsHint: "Ask again before the tools you allowed for this chat or always",
  allowedByGrant: "Allowed by your longer approval",
  durationMinutes: (minutes) => `${minutes} min`,
  durationHours: (hours) => `${hours} h`,
  durationHoursMinutes: (hours, minutes) => `${hours} h ${minutes} min`,
  grantTitle: "Work alongside you?",
  grantExtendTitle: "Keep working alongside you?",
  grantDuration: "For how long",
  grantPlaces: "I'll work in:",
  grantNewPlaces: "Also in:",
  grantMoreTime: (time) => `${time} longer`,
  grantMay: {
    read: "Without asking I may read there.",
    write: "Without asking I may write and change things there.",
    read_write: "Without asking I may read, write and change things there.",
  },
  grantStillAsks: "I'll still ask before deleting, sending, paying or publishing anything, and before anything else.",
  grantAllow: "Allow",
  grantNotNow: "Not now",
  grantRemovePlace: "Remove",
  grantKeepPlace: "Add back",
  grantAllowed: "Working alongside you",
  grantDeclined: "Not now",
  grantFailed: "Not allowed: the server did not confirm it",
  markerWorking: (left) => `Working alongside you · ${left} left`,
  markerPaused: "Working alongside you · paused",
  markerStop: "Stop",
  markerKeepGoing: (time) => `Another ${time}`,
  settingsApprovals: "Approvals",
  settingsApprovalsEmpty: "Nothing is allowed for longer than one call.",
  settingsGrantTime: (tool, left) => `${tool}, ${left} left`,
  settingsGrantWork: (places, left) => `Working alongside you in ${places}, ${left} left`,
  settingsAlways: (tool) => `${tool}, always`,
  revoke: "Revoke",
  bypassTitle: "Switch approvals off in this chat?",
  bypassNoLongerAsks: "For the time you pick, this agent runs its tools in this chat without asking you first, also those that delete, send or cannot be undone, and those nobody has classified. Your other chats ask as before.",
  bypassStillAsks: "Still asks: your administrator's \"Ask first\" rules and tools marked to always ask. What is blocked stays blocked.",
  bypassRecords: {
    decisions: "Your organisation's server records each tool that runs without asking: which tool, when and where, but not what it was given.",
    calls: "Your organisation's server records each tool that runs without asking, with what it was given (personal data masked).",
    results: "Your organisation's server records each tool that runs without asking, with what it was given and a short summary of its result (personal data masked).",
  },
  bypassNoExtension: "When the time is up, Bypass ends. It cannot be extended: more time is a new Bypass, confirmed again.",
  bypassReason: "Why (optional)",
  bypassReasonSeen: "Your administrators see your reason.",
  bypassAllow: "Switch Bypass on",
  bypassConfirming: "Waiting for the server to confirm…",
  bypassOn: "Bypass is on",
  bypassNotConfirmedUnknown: "Bypass is not on: the server did not confirm it. Approvals ask as before.",
  bypassNotConfirmed: {
    refused: "Bypass is not on: your organisation does not allow it for this agent now. Approvals ask as before.",
    offline: "Bypass is not on: the server could not be reached. Approvals ask as before.",
    unavailable: "Bypass is not on: the server cannot check its limits right now. Approvals ask as before.",
    denied: "Bypass stays off: it was not approved in the browser.",
    timed_out: "Bypass stays off: the sign-in in the browser took too long.",
    no_browser: "Bypass stays off: the browser could not be opened or the server not reached.",
  },
  bypassMarker: (left) => `Bypass on · ${left} left`,
  bypassRecorded: {
    decisions: "Each tool that runs is recorded.",
    calls: "Each tool that runs is recorded with what it was given.",
    results: "Each tool that runs is recorded with what it was given and its result.",
  },
  bypassStopName: "Stop Bypass",
  bypassSignIn: "Sign in again in your browser to switch Bypass on. This app waits until you approve it there.",
  bypassSignInCode: (code) => `The page shows the code ${code}.`,
  bypassOpenAgain: "Open the page again",
  bypassOpenAgainName: "Open the Bypass sign-in page again",
  bypassSwitchOnAgain: "Switch on again",
  bypassSwitchOnAgainName: "Switch Bypass on again",
  bypassListMarker: (left) => `Bypass · ${left} left`,
  bypassEndedUnknown: "Bypass ended: the server ended it. Approvals ask again.",
  bypassEnded: {
    person: "Bypass ended: you ended it. Approvals ask again.",
    expired: "Bypass ended: its time is up. Approvals ask again.",
    admin: "Bypass ended: an administrator ended it. Approvals ask again.",
    kill_switch: "Bypass ended: your organisation turned Bypass off. Approvals ask again.",
    limit: "Bypass ended: your organisation narrowed who may use it. Approvals ask again.",
    spent: "Bypass ended: its calls were used up. Approvals ask again.",
  },
  settingsGrantBypass: (left, recorded) => `Bypass in a chat, ${left} left · ${recorded}`,
  limitedByAgent: (description, mode) => `${description} This agent goes no higher than ${mode}.`,
  grantsMarkerMany: (count, first) => `${count} grants running · first ends in ${first}`,
  grantsLeft: (time) => `${time} left`,
  grantsPaused: "paused",
  grantsBadgePaused: "Paused",
  grantsBypassPaused: "Bypass paused",
  grantsKindWork: "Working alongside you",
  grantsChatUnknown: "A chat",
  grantsStopFailed: "Stop did not reach the server. Try again; the grants end at their time in any case.",
  grantsExtendFailed: "The time could not be extended",
  grantsAtLongest: "This cannot run any longer. To keep going, ask again and answer the card.",
  grantsWaiting: "The server could not check whether a grant may go on. It stays paused and is tried again shortly.",
  grantsSummaryWork: (time) => `Worked alongside you for ${time}`,
  grantsSummaryBypass: (time) => `Bypass ran for ${time}`,
  grantsSummaryPlaces: (places) => `Where: ${places}`,
  grantsSummaryCalls: (count) => `Ran without asking: ${count}`,
  grantsEnded: {
    time: "It ended when its time was up.",
    stopped: "You stopped it.",
    elsewhere: "The server ended it: in Settings, in another app, by an administrator, or its calls were used up.",
    spent: "It used up the calls it was allowed.",
    locked: "It ended because the screen stayed locked for 30 minutes.",
    away: "It ended because it stayed paused for 30 minutes while the app was closed.",
    admin: "An administrator ended it.",
    kill_switch: "It ended because your organisation turned it off.",
    limit: "It ended because your organisation narrowed who may use it.",
    host: "The app ended it.",
  },
  downloadCsv: "Download CSV",
  exportChat: "Export chat",
  exportChatTitle: "Chat",
  exportYou: "You",
  exportSkills: (list) => `Skills: ${list}`,
  exportAttachments: (list) => `Attachments: ${list}`,
  myPrompts: "My prompts",
  organisationSkills: "Your organisation's skills",
  promptsAndSkills: "Prompts and skills",
  noPrompts: "No saved prompts yet. Use \"Save as prompt\" on a message you sent.",
  noPromptMatches: (query) => `No prompt matches "${query}".`,
  promptPickerHint: "Enter picks, Esc closes the list.",
  deletePrompt: "Delete prompt",
  savePrompt: "Save as prompt",
  promptSaved: "Saved as a prompt",
  promptTooLong: (max) => `A prompt can have at most ${max} characters.`,
  promptsFull: (max) => `You can keep at most ${max} prompts. Delete one first.`,
  promptNotSaved: "The prompt could not be saved.",
  tools: "Tools",
  toolsInApp: "In this app",
  toolsFromServer: "From your organisation's server",
  toolsNoneInApp: "This app brings no tools.",
  toolsLoading: "Loading tools...",
  toolsNone: "No tools from your server",
  toolsFailed: "The tools could not be listed right now",
  toolStatusAvailable: "Available to this agent",
  toolStatusDisabled: "Switched off by your administrator",
  toolStatusNotAllowed: "Not allowed for this agent",
  // the connection wizard (sdk/51 F15)
  wizardBack: "Back",
  wizardContinue: "Continue",
  wizardCancel: "Cancel",
  wizardClose: "Close",
  wizardTryAgain: "Try again",
  wizardCheck: "Check",
  wizardChooseTitle: (app) => `How do you want to use ${app}?`,
  wizardChooseServer: "Connect to my organisation",
  wizardChooseServerHelp: "Your organisation runs Fadenstack: sign in with your account.",
  wizardChooseOwnAi: "Use my own AI",
  wizardChooseOwnAiHelp: "Connect to an AI server you choose: on this computer, in your network or at a provider.",
  wizardChooseDemo: "Try the demo",
  wizardNothingAllowed: "The settings of this computer allow none of these. Ask your IT.",
  wizardAppStepRefused: "Without this permission the app cannot go on.",
  wizardStoreFailed: "The app could not save its settings. Try again.",
  wizardServerTitle: "Connect to your organisation",
  wizardServerLabel: "Server address",
  wizardServerPlaceholder: "https://ai.example.com",
  wizardServerHelp: "Your IT gives you this address.",
  wizardServerLocked: "Your organisation set this address.",
  wizardServerAddressInvalid: "Enter the server's address, for example https://ai.example.com.",
  wizardServerHttpsRequired: "Enter the address as https://… Plain http works only for this computer.",
  wizardChecking: "Checking the server…",
  wizardUnreachable: "The server cannot be reached. Check the address and your network.",
  wizardCertificateNotTrusted: "The server's certificate is not trusted on this computer. Ask your IT: your organisation's certificate is set up on the computer, never here.",
  wizardNotFadenstack: "This address does not answer like a Fadenstack server. Check the address.",
  wizardRestarting: (server) => `Connected to ${server}. The app starts again so that you can sign in.`,
  wizardChangeServer: "Change the server",
  wizardServerAt: (server) => `Server: ${server}`,
  wizardStarting: "Asking the server for a code…",
  wizardCodeTitle: (app) => `Sign in to ${app}`,
  wizardCodeIntro: "Approve this computer in your browser. Your password stays in the browser.",
  wizardCodeName: "Your sign-in code",
  wizardCopyCode: "Copy the code",
  wizardOpenPage: "Open the sign-in page",
  wizardWaiting: (leftMs) => `Waiting for your approval… The code expires in ${minutesAndSeconds(leftMs)}.`,
  wizardWaitingRetry: (leftMs) => `The server cannot be reached for the moment. Trying again… The code expires in ${minutesAndSeconds(leftMs)}.`,
  wizardDenied: "The sign-in was denied in the browser.",
  wizardExpired: "The code expired.",
  wizardNewCode: "Get a new code",
  wizardTooOld: "This server does not support signing in with a code yet. Ask your IT to update Fadenstack.",
  wizardTooOldPassword: "You can sign in with your e-mail and password instead.",
  wizardStartFailure: {
    unreachable: "The server cannot be reached.",
    certificateNotTrusted: "The server's certificate is not trusted on this computer. Ask your IT.",
    rateLimited: "Too many sign-in attempts from this address. Try again in a moment.",
    pageElsewhere: "The server named its sign-in page on another address than its own. Ask your IT to check the proxy's settings.",
    serverError: "The server could not start a sign-in. Try again.",
  },
  wizardPairFailed: "The sign-in stopped. Try again.",
  wizardRedeeming: "Signing in…",
  wizardSignedInAs: (person) => `Signed in as ${person}.`,
  wizardSignedIn: "Signed in.",
  wizardNoAccess: "You have no access to this assistant. Ask your IT to give you access.",
  wizardSignInEnded: "Your sign-in ended. Sign in again.",
  wizardUsePassword: "Sign in with e-mail and password instead",
  wizardEmail: "E-mail",
  wizardPassword: "Password",
  wizardSignIn: "Sign in",
  wizardBackToCode: "Sign in with a code instead",
  wizardPasswordFailure: {
    badCredentials: "The e-mail or password is not right.",
    httpsRequired: "A password goes only over https: use the server's https address.",
    notFadenstack: "This address does not answer like a Fadenstack server.",
    unreachable: "The server cannot be reached.",
    certificateNotTrusted: "The server's certificate is not trusted on this computer. Ask your IT.",
    other: "The sign-in did not work. Try again.",
  },
  wizardOwnTitle: "Use your own AI",
  wizardOwnDataFlow: "What you write goes to the AI server you choose, and its answers come from there. Nothing goes to Fadenstack.",
  wizardOwnProviderTerms: "The provider's terms are between you and the provider.",
  wizardOwnNotice: "In this mode the agent connects directly to the model endpoint you choose. Fadenstack runs no server in this mode. On your device, the agent marks AI-generated content where this is technically feasible: it writes signed, machine-readable information into document and e-mail properties and keeps a local record. Whether chat text and inserted text also carry an invisible text watermark depends on your endpoint; the agent shows the status for your connection. Server mode can add a text watermark during generation. This mode makes no pictures. Metadata can be lost when content is copied, converted or edited. If you use AI-generated content in your work or publish it, you may have your own disclosure duties, for example under Article 50(4) of the EU AI Act for deep fakes and for texts published to inform the public on matters of public interest. Please do not remove or alter the markings, except for legitimate purposes such as security testing.",
  wizardOwnLiability: "We provide the software free of charge and are therefore liable only for intent and gross negligence (Section 521 of the German Civil Code). Liability under the Product Liability Act and for injury to life, body or health remains unaffected.",
  wizardOwnBindingVersion: "The German text is the binding version.",
  wizardOwnFullTerms: "Read the full terms",
  wizardOwnConsent: "I have read this and accept the terms.",
  wizardOwnSearchConsent: "Look for AI servers on this computer (Ollama, LM Studio, vLLM, llama.cpp)",
  wizardOwnAccept: "Accept and continue",
  wizardOwnServerInstead: "Set up server mode instead",
  wizardOwnSearching: "Looking for AI servers on this computer…",
  wizardOwnPickTitle: "Choose your AI",
  wizardOwnFound: "Found on this computer",
  wizardOwnNothingFound: "No AI server was found on this computer.",
  wizardOwnPresets: "Providers and servers",
  wizardOwnAddress: "Address",
  wizardOwnAddressPlaceholder: "https://…/v1",
  wizardOwnNeedsKey: "This server needs a key",
  wizardOwnUse: "Use this",
  wizardEndpointAddressInvalid: "Enter an address that starts with https:// (or http:// for this computer).",
  wizardEndpointHttpsRequired: "Use the https address. Plain http works only for this computer, and for your local network after you confirm it.",
  wizardAddressNotAllowed: "The settings of this computer do not allow this address. Ask your IT.",
  wizardAddressPlainHttpForbidden: "The settings of this computer do not allow plain http. Use the https address.",
  wizardAddressKeyNeedsHttps: "A key never goes over plain http to another computer. Use the https address.",
  wizardPlainHttpTitle: "Plain http in your local network",
  wizardPlainHttpWarning: "This address is in your local network and uses plain http: others in the network could read what you send and receive. Use it only in a network you trust. No key can be used with it.",
  wizardPlainHttpConfirm: "Use it anyway",
  wizardKeyTitle: "The key",
  wizardKeyLabel: "API key",
  wizardKeyHelp: "The key is kept in this computer's key store, never in a file.",
  wizardOwnChecking: "Checking the connection…",
  wizardProblem: {
    Unreachable: "The server cannot be reached. Is it running, and is the address right?",
    CertificateNotTrusted: "The server's certificate is not trusted on this computer. Ask your IT.",
    PlainHttpRefused: "Plain http is not allowed for this address.",
    KeyRejected: "The server refused the key.",
    OriginRefused: "The server refused this app's requests. It has to allow this app first.",
    NotCompatible: "This server does not answer like an OpenAI-compatible endpoint.",
    RateLimited: "The server has too many requests right now. Try again in a moment.",
    ModelNotFound: "The server does not have this model.",
    NoToolCalls: "This model can only chat: it cannot use tools.",
    NoUsage: "The server does not report how many tokens were used.",
    ContextTooShort: "The model's context is too short for the agent: choose a model with a longer context, or raise the server's setting.",
    OllamaDefaultContext: "Ollama runs this model with its short default context, which cuts long prompts. Raise OLLAMA_CONTEXT_LENGTH.",
    WatermarkRequestRefused: "The server does not add its text watermark, so requests go without it.",
    KeyUnencryptedOnThisComputer: "The key goes unencrypted to the server on this computer (plain http).",
    Failed: "The check did not work. Try again.",
  },
  wizardEnterKey: "Enter the key again",
  wizardShowHelp: "How to allow it",
  wizardOwnHelpTitle: "Allow this app",
  wizardOwnHelp: "Ollama answers only to the apps it knows: add this app's origin to OLLAMA_ORIGINS and start Ollama again. In LM Studio, switch on CORS in the server's settings.",
  wizardOwnWorks: "The connection works.",
  wizardWatermark: {
    Unknown: "Whether this connection marks text with a watermark is not known.",
    Marks: "This connection marks text with an invisible watermark.",
    IfAccountEnabled: "This connection marks text only when the account has it switched on.",
    IfOperatorConfigured: "This connection marks text only when the server's operator set it up.",
    Never: "This connection does not mark text with a watermark.",
  },
  wizardWatermarkConfirmed: "The server confirmed its watermark.",
  wizardModelTitle: "Choose the model",
  wizardModelLabel: "Model",
  wizardOwnDone: "Your AI is ready.",
  wizardSettingsTitle: "Connection",
  wizardConnectedServer: (server) => `Connected to ${server}.`,
  wizardConnectedEndpoint: (endpoint) => `Your own AI: ${endpoint}.`,
  wizardConnectOrganisation: "Connect to my organisation",
  wizardChangeEndpoint: "Change the AI",
  wizardSignOut: "Sign out",
  wizardRemoveEndpoint: "Remove this AI",
  wizardSignOutTitle: "Sign out on this computer?",
  wizardSignOutBody: "The sign-in ends at the server and on this computer.",
  wizardRemoveTitle: "Remove this AI from this computer?",
  wizardRemoveBody: "Its key is deleted from this computer's key store.",
  wizardDeleteChats: "Also delete the chats kept on this computer",
  // the skill library, the editor and "Draft from this chat" (sdk/51 F04)
  skillLibraryTitle: "Skills on this device",
  skillLibraryLoading: "Reading the skills…",
  skillLibraryFailed: "The skills could not be read.",
  skillLibraryEmpty: "There are no skills yet. Create one, or import a folder or a zip.",
  skillOriginBundled: "Built in",
  skillOriginOwn: "Yours",
  skillOriginOrganisation: "Your organisation",
  skillNotReviewed: "Not reviewed",
  skillOn: "On",
  skillOff: "Off",
  skillNew: "New skill",
  skillEdit: "Edit",
  skillView: "View",
  skillDuplicate: "Duplicate",
  skillDelete: "Delete",
  skillImport: "Import…",
  skillExport: "Export",
  skillCancel: "Cancel",
  skillSave: "Save",
  skillReplace: "Replace",
  skillDeleteTitle: (name) => `Delete ${name}?`,
  skillDeleteBody: "Its folder and files are removed from this computer. This cannot be undone.",
  skillImportTitle: (name) => `Import ${name}?`,
  skillImportBody: "It is added to your skills and marked as not reviewed. Read it first: it is text from outside, and the model will follow it.",
  skillImportReplaceBody: (name) => `A skill named ${name} is already here. Importing replaces it.`,
  skillImportRefused: "This cannot be imported. Nothing was written.",
  skillImported: (name) => `${name} was imported.`,
  skillSaved: (name) => `${name} was saved.`,
  skillDeleted: (name) => `${name} was deleted.`,
  skillExported: (name) => `${name} was exported.`,
  skillExportFailed: (name) => `${name} could not be exported.`,
  skillSaveFailed: "The skill could not be written. Nothing was changed.",
  skillExistsTitle: (name) => `Replace ${name}?`,
  skillExistsBody: "A skill with this name already exists. Saving replaces it.",
  skillEditorEditing: (name) => `Editing ${name}`,
  skillEditorReadOnly: (name) => `${name} is read only.`,
  skillEditorProposal: "A proposed skill. Read it, and save it only if you want to keep it.",
  skillName: "Name",
  skillDescription: "Description",
  skillInstructions: "Instructions",
  skillPreview: "Preview",
  skillLicense: "License",
  skillCompatibility: "Compatibility",
  skillMatching: "When to use it",
  skillTitleField: "Title",
  skillTags: "Tags",
  skillKeywords: "Keywords",
  skillFileTypes: "File types",
  skillPreferredTools: "Preferred tools",
  skillPriority: "Priority",
  skillActivation: "Activation",
  skillActivationAuto: "When the message matches",
  skillActivationAlways: "Always",
  skillActivationManual: "Only when named",
  skillResources: "Files",
  skillNoResources: "No other files.",
  skillAddFile: "Add a file…",
  skillRenameFile: "Rename",
  skillRemoveFile: "Remove",
  skillDropUnknownKeys: "Remove the extra fields",
  skillChecksHeading: "Checks",
  skillChecksOk: "All checks pass.",
  skillTestHeading: "Try it",
  skillTestPrompt: "A message to try",
  skillTestRun: "Try",
  skillTestListed: "The model is told about:",
  skillTestPreloaded: "Loaded at once:",
  skillTestNone: "No skill is offered for this message.",
  skillTestEditedNotListed: "This skill is not offered for this message.",
  skillMatchExplicit: "named in the message",
  skillMatchAlways: "always on",
  skillMatchTrigger: "matches its keywords",
  skillAskModel: "Ask the model once",
  skillModelNote: "One model call. No tool runs.",
  skillModelAsking: "Asking the model…",
  skillModelWouldLoad: (name) => `The model would load ${name}.`,
  skillModelWouldLoadOther: (name) => `The model would load another skill instead: ${name}.`,
  skillModelWouldNot: "The model would not load a skill for this message.",
  skillModelFailed: "The model could not be asked.",
  skillDraftTitle: "Draft from this chat",
  skillDraftGuidance: "What should the skill be for? (optional)",
  skillDraftStart: "Write a draft",
  skillDraftWorking: "Writing a draft…",
  skillDraftReady: "The draft is open for review. Nothing is saved until you press Save.",
  skillDraftNoChat: "There is nothing in this chat to draft from yet.",
  skillDraftNoModel: "No model is available to write a draft.",
  skillDraftFailed: "The draft could not be written.",
  skillDraftUnreadable: "The model’s answer is not a skill. Try again.",
  skillDraftBroken: "The draft breaks the rules listed below. Fix it in the editor before saving.",
  skillIssue: {
    NameMissing: "The name is empty.",
    NameForm: "The name may use only lower-case letters, digits and single hyphens.",
    NameTooLong: "The name is {2} characters long; the limit is {1}.",
    NameNotFolder: "The name is not the folder’s name ({3}).",
    NameReserved: "A built-in skill already has this name.",
    DescriptionMissing: "The description is empty. It tells the model when to use the skill.",
    DescriptionTooLong: "The description is {2} characters long; the limit is {1}.",
    CompatibilityTooLong: "The compatibility note is {2} characters long; the limit is {1}.",
    UnknownKey: "SKILL.md has a field the standard does not have: {3}. Remove it.",
    InvisibleCharacter: "{0} contains an invisible character ({3}). Remove it.",
    ControlCharacter: "{0} contains a control character ({3}). Remove it.",
    BodyEmpty: "The instructions are empty.",
    BodyLarge: "The instructions are long (about {2} tokens; about {1} is advisable). The model may follow them less well.",
    TotalTooLarge: "The skill is larger than {1} bytes in all.",
    FileTooLarge: "{0} is larger than {1} bytes.",
    TooManyFiles: "The skill has more than {1} files.",
    ScriptFile: "{0} is a script or a program. Scripts never run here; remove it.",
    UnsafePath: "The file name {0} is not allowed ({3}).",
    DuplicatePath: "The file name {0} appears twice.",
    LinkEntry: "{0} is a link. Links are not taken in.",
    ZipBomb: "The zip expands to far more than it should. It was not opened.",
    NotAZip: "{0} is not a zip file.",
    SkillMdMissing: "There is no SKILL.md.",
    SkillMdUnreadable: "SKILL.md cannot be read: {3}",
    FadenYamlUnreadable: "faden.yaml cannot be read: {3}",
    FadenYamlUnknownKey: "faden.yaml has a field this editor does not keep: {3}. Saving drops it.",
    ReadFailed: "{0} could not be read.",
    BinaryFile: "{0} is not a text file. A skill keeps text files only.",
  },
};

/** Minutes and seconds as "9:41" (like .NET's `MinutesAndSeconds`): rounded up to the whole second, never negative. */
export function minutesAndSeconds(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * `base` (English by default) with the host's changes on top: what `changes` leaves out, `base` says. Groups
 * (`modes`, `approvalWhy`, ...) are completed key by key, so a host can change one mode's words.
 */
export function withStrings(changes: Partial<UiStrings> | undefined, base: UiStrings = englishStrings): UiStrings {
  if (!changes) return base;
  return {
    ...base,
    ...changes,
    toolClass: { ...base.toolClass, ...changes.toolClass },
    approvalClass: { ...base.approvalClass, ...changes.approvalClass },
    approvalWhy: { ...base.approvalWhy, ...changes.approvalWhy },
    noticeTitles: { ...base.noticeTitles, ...changes.noticeTitles },
    modes: { ...base.modes, ...changes.modes },
    grantMay: { ...base.grantMay, ...changes.grantMay },
    bypassRecords: { ...base.bypassRecords, ...changes.bypassRecords },
    bypassNotConfirmed: { ...base.bypassNotConfirmed, ...changes.bypassNotConfirmed },
    bypassRecorded: { ...base.bypassRecorded, ...changes.bypassRecorded },
    bypassEnded: { ...base.bypassEnded, ...changes.bypassEnded },
    grantsEnded: { ...base.grantsEnded, ...changes.grantsEnded },
    wizardStartFailure: { ...base.wizardStartFailure, ...changes.wizardStartFailure },
    wizardPasswordFailure: { ...base.wizardPasswordFailure, ...changes.wizardPasswordFailure },
    wizardProblem: { ...base.wizardProblem, ...changes.wizardProblem },
    wizardWatermark: { ...base.wizardWatermark, ...changes.wizardWatermark },
    skillIssue: { ...base.skillIssue, ...changes.skillIssue },
  };
}
