import { DEFAULT_SUPPORT_EMAIL, isSupportEmail } from "@fadenstack/agents";
import { FadenstackApiError, FadenstackError, FadenstackStreamError } from "@fadenstack/client";

import type { PanelLink } from "./about.js";
import type { UiStrings } from "./strings.js";

/**
 * "Report a problem" (SDK 0.3.1): what the sheet says to whom, and the mail it prepares. The SDK sends nothing: the person's mail app
 * sends the `mailto:` link, or the person pastes the copied text into webmail. Everything here is pure, so the .NET SDK (the same spec)
 * and this one give byte-identical subjects, bodies and copies for the same inputs: `test/reportProblem/cases.json` is the shared table.
 *
 * Never in the report: prompts, answers, reasoning, attachments, file or page names, tool names or arguments, keys, tokens, the
 * person's name, mail address or user id, the endpoint's address. The builder takes only the facts below, so none of that can reach it.
 */

/** The `mailto:` link is at most this many characters; the body's last lines go first when it would be longer. */
export const MAILTO_MAX_LENGTH = 2000;
/** The browser log's entries "Copy details" adds. */
export const RECENT_LOG_ENTRIES = 50;

/** The mail's labels and subject texts, in the panel's language. */
export interface ReportLabels {
  /** `Problem with Word add-in 1.2.0`. */
  subject(app: string): string;
  /** `Problem with Fadenstack SDK 0.3.1`. */
  subjectNoApp(version: string): string;
  whatHappened: string;
  app: string;
  sdk: string;
  system: string;
  mode: string;
  agent: string;
  server: string;
  endpoint: string;
  time: string;
  error: string;
  to: string;
  subjectLabel: string;
  recentLog: string;
}

/** The labels from the panel's texts. */
export function reportLabels(strings: UiStrings): ReportLabels {
  return {
    subject: (app) => strings.reportSubject(app),
    subjectNoApp: (version) => strings.reportSubjectNoApp(version),
    whatHappened: strings.reportWhatHappened,
    app: strings.reportApp,
    sdk: strings.reportSdk,
    system: strings.reportSystem,
    mode: strings.reportMode,
    agent: strings.reportAgent,
    server: strings.reportServer,
    endpoint: strings.reportEndpoint,
    time: strings.reportTime,
    error: strings.reportError,
    to: strings.reportTo,
    subjectLabel: strings.reportSubjectLabel,
    recentLog: strings.reportRecentLog,
  };
}

/** The error of a failed turn: its code, and the server's request id where the error has one. */
export interface ReportedError {
  code?: string | undefined;
  requestId?: string | undefined;
}

/** What the report says, each value as the mail shows it; a value that is unknown is left out (its line too). */
export interface ReportFacts {
  /** The app's name and version as the host described it: `Word add-in 1.2.0`. Absent: the host did not describe its app. */
  app?: string | undefined;
  /** The SDK's version, for the subject: `0.3.1`. */
  sdkVersion: string;
  /** The SDK line: `Fadenstack SDK 0.3.1 (TypeScript)`. */
  sdk: string;
  /** `Chrome 131, Windows` (`describeSystem`). */
  system?: string | undefined;
  /** The mode, in the panel's word for it. */
  mode?: string | undefined;
  /** `Docs, Version 3, Model: qwen3-32b`. */
  agent?: string | undefined;
  /** Governed: the address About shows. */
  server?: string | undefined;
  /** Standalone: the dialect's name and where it points, `ollama, on this computer`; never its address. */
  endpoint?: string | undefined;
  /** `2026-11-19 10:42 UTC` (`reportTime`). */
  time: string;
  /** Only from a failed turn. */
  error?: ReportedError | undefined;
}

/** What `buildReport` takes. */
export interface ReportInput {
  /** The address the report goes to, one plain address (`isSupportEmail`); absent: no mail (governed without a policy address). */
  address?: string | undefined;
  labels: ReportLabels;
  facts: ReportFacts;
  /** The browser log's last entries, each as one line (`recentLogLines`): "Copy details" only, never the mail. */
  log?: readonly string[] | undefined;
}

/** The report: the mail's subject and body, the `mailto:` link, and the text "Copy details" copies. */
export interface ReportMail {
  to: string | undefined;
  subject: string;
  /** The body in full, with CRLF line breaks. */
  body: string;
  /** The body that goes into the `mailto:` link (the lines that fit), CRLF. Equals `body` unless lines were dropped. */
  mailBody: string;
  /** How many of the body's lines the 2 000 limit dropped from its end. */
  dropped: number;
  /** `mailto:<address>?subject=..&body=..`, at most 2 000 characters; undefined without an address. */
  mailto: string | undefined;
  /** What "Copy details" copies: To, Subject, the body with LF line breaks, and the log's entries when there are any. */
  copy: string;
}

/**
 * The mail and the copy. Values lose control characters and line breaks (a value is one line). Throws a `TypeError` for an address that
 * is not one plain address: the builder never writes one into a link (OWASP ASVS 5.0 V1).
 */
export function buildReport(input: ReportInput): ReportMail {
  const { labels, facts } = input;
  const address = input.address;
  if (address !== undefined && !isSupportEmail(address)) throw new TypeError("The support address must be one plain mail address.");

  const app = oneLine(facts.app);
  const subject = app ? `${labels.subject(app)} (Fadenstack SDK ${oneLine(facts.sdkVersion)})` : labels.subjectNoApp(oneLine(facts.sdkVersion));

  const line = (label: string, value: string | undefined): string[] => {
    const text = oneLine(value);
    return text ? [`${label}: ${text}`] : [];
  };
  const error = facts.error;
  const code = oneLine(error?.code);
  const requestId = oneLine(error?.requestId);
  const items = [
    ...line(labels.app, app),
    ...line(labels.sdk, facts.sdk),
    ...line(labels.system, facts.system),
    ...line(labels.mode, facts.mode),
    ...line(labels.agent, facts.agent),
    ...line(labels.server, facts.server),
    ...line(labels.endpoint, facts.endpoint),
    ...line(labels.time, facts.time),
    ...(code ? [`${labels.error}: ${code}${requestId ? ` (${requestId})` : ""}`] : []),
  ];

  // The person writes between the first line and the separator; with no line below it the separator is left out too.
  const bodyOf = (lines: readonly string[]): string[] => [`${labels.whatHappened}:`, "", "", ...(lines.length > 0 ? ["-- ", ...lines] : [])];
  const full = bodyOf(items);
  const crlf = (lines: readonly string[]) => lines.join("\r\n");
  const body = crlf(full);

  let mailBody = body;
  let dropped = 0;
  let mailto: string | undefined;
  if (address !== undefined) {
    const link = (text: string) => `mailto:${address}?subject=${encodeComponent(subject)}&body=${encodeComponent(text)}`;
    let kept = items.length;
    mailto = link(body);
    // The last lines go first (the error, then the time, ...); never the subject or the first line.
    while (mailto.length > MAILTO_MAX_LENGTH && kept > 0) {
      kept--;
      mailBody = crlf(bodyOf(items.slice(0, kept)));
      mailto = link(mailBody);
    }
    dropped = items.length - kept;
  }

  const head = [...(address !== undefined ? [`${labels.to}: ${address}`] : []), `${labels.subjectLabel}: ${subject}`, ""];
  const log = (input.log ?? []).map((entry) => oneLine(entry)).filter(Boolean);
  const copy = [...head, ...full, ...(log.length > 0 ? ["-- ", `${labels.recentLog}:`, ...log] : [])].join("\n");
  return { to: address, subject, body, mailBody, dropped, mailto, copy };
}

/** UTF-8 percent-encoding of everything outside RFC 3986's unreserved characters (`A-Z a-z 0-9 - . _ ~`): CRLF is `%0D%0A`, a space `%20`. */
export function encodeComponent(text: string): string {
  let out = "";
  for (const byte of new TextEncoder().encode(text)) {
    const unreserved = (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || (byte >= 0x30 && byte <= 0x39)
      || byte === 0x2d || byte === 0x2e || byte === 0x5f || byte === 0x7e;
    out += unreserved ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/** A value as one line: control characters and line breaks become a space, a lone surrogate U+FFFD, and the ends are trimmed. */
function oneLine(value: string | undefined): string {
  return value === undefined ? "" : value.replace(CONTROLS, " ").replace(LONE_SURROGATE, "\ufffd").trim();
}

/**
 * Who the report goes to. The machine policy's `supportEmail` first, in both modes; in standalone mode then the host's own address, then
 * Fadenstack's (`support@fadenstack.com`). In governed mode only the policy's counts: never the host's, never ours (owner, 18 Nov 2026).
 * Undefined: no mail (governed, without the key). An address that is not one plain address is skipped as if absent.
 */
export function supportAddress(governed: boolean, policy: string | undefined, host: string | undefined): string | undefined {
  if (isSupportEmail(policy)) return policy;
  if (governed) return undefined;
  return isSupportEmail(host) ? host : DEFAULT_SUPPORT_EMAIL;
}

/** The time as the report says it: `2026-11-19 10:42 UTC`. */
export function reportTime(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** The browser log's last `RECENT_LOG_ENTRIES` entries (oldest first) as lines: `<at> <level> <category> <eventId> <message>`. */
export function recentLogLines(entries: readonly { at: string; level: string; category: string; eventId: number; message: string }[]): string[] {
  return entries.slice(-RECENT_LOG_ENTRIES).map((e) => `${e.at} ${e.level} ${e.category} ${e.eventId} ${e.message}`);
}

/** What the environment says of itself, for `describeSystem`; a test passes its own. */
export interface SystemEnvironment {
  userAgentData?: { brands?: readonly { brand: string; version: string }[] | undefined; platform?: string | undefined } | undefined;
  userAgent?: string | undefined;
  /** Node: `{ version: "22.11.0", platform: "win32" }`. */
  node?: { version: string; platform: string } | undefined;
}

/** The running environment: a browser's `navigator`, or Node's `process`. */
export function currentSystem(): SystemEnvironment {
  const g = globalThis as { navigator?: { userAgentData?: SystemEnvironment["userAgentData"]; userAgent?: string }; process?: { versions?: { node?: string }; platform?: string }; window?: unknown };
  if (g.window === undefined && typeof g.process?.versions?.node === "string") return { node: { version: g.process.versions.node, platform: g.process.platform ?? "" } };
  return { userAgentData: g.navigator?.userAgentData, userAgent: g.navigator?.userAgent };
}

/**
 * The browser's name and major version and the OS family (`Chrome 131, Windows`), from `navigator.userAgentData` (its brands and
 * platform) where there is one, else a small parse of the user agent; in Node `Node 22, win32`. Never the full user-agent string.
 * Undefined where nothing is known.
 */
export function describeSystem(env: SystemEnvironment = currentSystem()): string | undefined {
  if (env.node) {
    const major = /^\d+/.exec(env.node.version)?.[0];
    return [major ? `Node ${major}` : "Node", env.node.platform].filter(Boolean).join(", ");
  }
  const data = env.userAgentData;
  const ua = env.userAgent ?? "";
  let browser = brandOf(data?.brands) ?? browserOf(ua);
  const os = oneLine(data?.platform) || osOf(ua);
  if (browser && browser.length > 40) browser = browser.slice(0, 40);
  return [browser, os].filter(Boolean).join(", ") || undefined;
}

const BRAND_NAMES: Record<string, string> = { "google chrome": "Chrome", "microsoft edge": "Edge", "opera": "Opera", "brave": "Brave" };

function brandOf(brands: readonly { brand: string; version: string }[] | undefined): string | undefined {
  if (!Array.isArray(brands)) return undefined;
  const usable = brands.filter((b) => typeof b?.brand === "string" && !/not.?a.?brand/i.test(b.brand) && oneLine(b.brand));
  const pick = usable.find((b) => !/^chromium$/i.test(b.brand)) ?? usable[0];
  if (!pick) return undefined;
  const name = BRAND_NAMES[pick.brand.toLowerCase()] ?? oneLine(pick.brand);
  const major = /^\d+/.exec(String(pick.version ?? ""))?.[0];
  return major ? `${name} ${major}` : name;
}

function browserOf(ua: string): string | undefined {
  const rules: [RegExp, string][] = [
    [/\bEdg(?:e|A|iOS)?\/(\d+)/, "Edge"],
    [/\bOPR\/(\d+)/, "Opera"],
    [/\b(?:Firefox|FxiOS)\/(\d+)/, "Firefox"],
    [/\b(?:Chrome|CriOS)\/(\d+)/, "Chrome"],
    [/\bVersion\/(\d+)[^]*\bSafari\//, "Safari"],
  ];
  for (const [pattern, name] of rules) {
    const match = pattern.exec(ua);
    if (match) return `${name} ${match[1]}`;
  }
  return undefined;
}

function osOf(ua: string): string | undefined {
  if (/\b(?:iPhone|iPad|iPod)\b/.test(ua)) return "iOS";
  if (/\bAndroid\b/.test(ua)) return "Android";
  if (/\bCrOS\b/.test(ua)) return "ChromeOS";
  if (/\bWindows\b/.test(ua)) return "Windows";
  if (/\bMac(?:intosh| OS X)\b/.test(ua)) return "macOS";
  if (/\bLinux\b/.test(ua)) return "Linux";
  return undefined;
}

/**
 * A failed turn's error as the report names it: the code (`FadenstackApiError.code`, `FadenstackStreamError.code`; `http_<status>` for
 * an API error without one; the class's name for another `FadenstackError`) and a request id when the error carries one (`requestId`).
 * Only plain tokens (`A-Z a-z 0-9 _ . : -`, at most 64 characters) are taken: a server's code is never written into a mail unchecked.
 */
export function errorForReport(error: unknown): ReportedError | undefined {
  const token = (value: unknown): string | undefined => (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : undefined);
  let code: string | undefined;
  let requestId: string | undefined;
  for (let e: unknown = error, depth = 0; e instanceof Error && depth < 8; e = e.cause, depth++) {
    requestId ??= token((e as { requestId?: unknown }).requestId);
    if (code !== undefined) continue;
    if (e instanceof FadenstackApiError) code = token(e.code) ?? `http_${e.status}`;
    else if (e instanceof FadenstackStreamError) code = token(e.code) ?? token(e.name);
    else if (e instanceof FadenstackError) code = token(e.name);
  }
  return code === undefined && requestId === undefined ? undefined : { code, requestId };
}

/** The sheet, in the panel's language. */
export interface ReportProblemView {
  title: string;
  /** Who receives it ("This goes to ..."), or that IT is to be asked. */
  goesTo: string;
  /** The address; undefined in governed mode without the policy's key. */
  address: string | undefined;
  /** The mail can be written: there is an address. */
  canWriteMail: boolean;
  /** Governed without an address: the organisation's Help, when there is a server. */
  help: PanelLink | undefined;
  contains: string;
  /** The report's lines as the mail carries them, LF line breaks, for the read-only text region. */
  preview: string;
  noChats: string;
  writeMail: string;
  copyDetails: string;
  close: string;
  /** The `mailto:` link, undefined without an address. */
  mailto: string | undefined;
}
