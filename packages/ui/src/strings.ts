import type { ToolClass, ToolMode } from "@fadenstack/client";

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
  /** A visible label on content made with AI, where the organisation asks for one. */
  aiGenerated: string;
  /**
   * The tooltip (`title`) on content made with AI that an agent put into a page or a mail: `aiGenerated`, a space, the
   * record's id, in every language (the .NET SDK and the host agents write the same, and readers find the id so).
   */
  aiGeneratedTitle(record: string): string;
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
}

export const englishStrings: UiStrings = {
  language: "en",
  direction: "ltr",
  languageName: "English",
  working: "Working...",
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
  aiGenerated: "AI-generated",
  aiGeneratedTitle: (record) => `AI-generated ${record}`,
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
};

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
  };
}
