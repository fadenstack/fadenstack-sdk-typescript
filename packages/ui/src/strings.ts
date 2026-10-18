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
  /** The tooltip (`title`) on content made with AI that an agent put into a page or a mail, with its record's id. */
  aiGeneratedTitle(record: string): string;
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
  },
  noticeFallback: "Notice",
  tryAgainIn: (seconds) => `Try again in ${seconds} s.`,
  decision: (id) => `Decision ${id}`,
  piiTitle: "Personal data protected",
  piiMessage: (total, list) => `${total} value${total === 1 ? "" : "s"} kept from the model: ${list}`,
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
  aiGeneratedTitle: (record) => `AI-generated (record ${record})`,
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
  };
}
