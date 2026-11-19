import { FadenstackError } from "@fadenstack/client";

import { AuditRetention } from "./audit.js";
import { DEFAULT_CHAT_RETENTION, chatRetentionChoice, isValidRetentionChats, isValidRetentionDays, type ChatRetentionChoice } from "./chatRetention.js";
import { isSupportEmail } from "./supportEmail.js";

/** A machine policy's word on a feature: allowed, forbidden, or allowed only for the listed items. The strings are .NET's `PolicyAccess` names. */
export const PolicyAccess = Object.freeze({
  Allowed: "Allowed",
  Forbidden: "Forbidden",
  /** Allowed only for `PolicyRule.items` (MCP sources, skill folders, endpoints). */
  Listed: "Listed",
});
export type PolicyAccess = (typeof PolicyAccess)[keyof typeof PolicyAccess];

/** What the policy's `timestamping` says: on (the app's default authority), off, or the organisation's own server. .NET: `TimestampingMode`. */
export const TimestampingMode = Object.freeze({
  On: "on",
  Off: "off",
  /** The organisation's own time-stamp server (`TimestampingPolicy.server`). */
  OwnServer: "ownServer",
} as const);
export type TimestampingMode = (typeof TimestampingMode)[keyof typeof TimestampingMode];

/** The policy's `timestamping` (sdk/51 F09, F10): `on`, `off`, or the address of an own time-stamp server. .NET: `TimestampingPolicy`. */
export interface TimestampingPolicy {
  readonly mode: TimestampingMode;
  /** The own server's address; set only for `ownServer`. */
  readonly server?: URL;
}
export const TimestampingPolicy = Object.freeze({
  on: Object.freeze<TimestampingPolicy>({ mode: TimestampingMode.On }),
  off: Object.freeze<TimestampingPolicy>({ mode: TimestampingMode.Off }),
});

/** One key of a machine policy: its access and, for a list, the items. .NET: `PolicyRule`. */
export class PolicyRule {
  static readonly allowed = new PolicyRule(PolicyAccess.Allowed, []);
  static readonly forbidden = new PolicyRule(PolicyAccess.Forbidden, []);

  readonly access: PolicyAccess;
  readonly items: readonly string[];

  constructor(access: PolicyAccess, items: readonly string[] = []) {
    this.access = access;
    this.items = Object.freeze([...items]);
    Object.freeze(this);
  }

  /** Whether anything at all is allowed (a list counts when it names something). */
  get allowsAny(): boolean {
    return this.access === PolicyAccess.Allowed || (this.access === PolicyAccess.Listed && this.items.length > 0);
  }

  /** Whether `item` is allowed: everything when allowed, only a listed one when listed (compared without regard to case). */
  allows(item: string): boolean {
    return this.access === PolicyAccess.Allowed
      || (this.access === PolicyAccess.Listed && this.items.some((i) => i.toLowerCase() === item.toLowerCase()));
  }
}

/** What a policy is made of; every key is optional (the defaults of a policy with no server). */
export interface MachinePolicyInit {
  server?: URL | undefined;
  standalone?: PolicyAccess;
  endpoints?: readonly string[] | null;
  plainHttp?: PolicyAccess;
  mcp?: PolicyRule;
  skills?: PolicyRule;
  webSearch?: PolicyAccess;
  timestamping?: TimestampingPolicy;
  chatRetention?: ChatRetentionChoice | undefined;
  contentLogging?: PolicyAccess;
  auditRetentionDays?: number | undefined;
  supportEmail?: string | undefined;
  locked?: readonly string[];
  warnings?: readonly string[];
}

const KEYS: readonly string[] = Object.freeze(["server", "standalone", "endpoints", "plainHttp", "mcp", "skills", "webSearch", "timestamping", "chatRetention", "contentLogging", "auditRetentionDays", "supportEmail"]);

/**
 * What IT set for this machine (sdk/51 F09, D6, R3-8): one vocabulary for every app, read from the app's managed location
 * (Chrome's `chrome.storage.managed`, handed to `MachinePolicy.from`). It wins over the person's settings and is enforced in
 * the SDK (`AgentBuilder.useMachinePolicy`), not only in an app's UI, so a third-party app cannot bypass it. .NET:
 * `MachinePolicy` (with `Load(path)`, which a browser has no use for).
 *
 * Fail closed: an unknown key is ignored and reported (`warnings`); an unknown value narrows, to forbidden. Where a `server`
 * is set, standalone, local MCP, local skills and web search are forbidden unless the policy allows them (R3-8): an
 * organisation that runs a server must not find "Use my own AI" in its users' agents.
 */
export class MachinePolicy {
  /** No policy at all: everything the person may choose stays theirs. */
  static readonly none = new MachinePolicy();

  /**
   * For a host whose policy source failed (Chrome's `chrome.storage.managed.get()` threw or timed out, a policy the app
   * could not open): use it instead of `none`, which allows everything. It forbids what the person could add or turn on
   * (standalone, local MCP, local skills, web search, plain http), turns time-stamps off (less leaves the device) and locks
   * those keys; `server` stays open, so the person can still sign in to their organisation's server by hand. .NET:
   * `MachinePolicy.Unreadable`.
   */
  static readonly unreadable: MachinePolicy = MachinePolicy.#closed("The machine policy could not be read");

  /** The known keys, as a policy names them. */
  static readonly keys: readonly string[] = KEYS;

  /** The organisation's server: the app enrols, and the person signs in at the next start. */
  readonly server: URL | undefined;
  /** "Use my own AI": forbidden by default where `server` is set, allowed otherwise. */
  readonly standalone: PolicyAccess;
  /** The endpoints a standalone agent may use (base URLs or origins); null: any. */
  readonly endpoints: readonly string[] | null;
  /** Plain http in the local network (D3's opt-in): forbidden here removes the opt-in. Loopback stays. */
  readonly plainHttp: PolicyAccess;
  /** Local MCP servers: allowed, forbidden, or the listed sources only. */
  readonly mcp: PolicyRule;
  /** Local skills: allowed, forbidden, or the listed folders only. */
  readonly skills: PolicyRule;
  /** The `web_search` tool. */
  readonly webSearch: PolicyAccess;
  /** RFC 3161 time-stamps for records signed on the device (only a hash leaves the device; F10): on, off, or an own server. */
  readonly timestamping: TimestampingPolicy;
  /**
   * How long a standalone agent keeps old chats, fixed by IT (`chatRetention`: `autoDelete`, `maxAgeDays`, `maxSessions`);
   * undefined when the policy leaves it to the person. A governed agent follows its server instead. .NET: `MachinePolicy.ChatRetention`.
   */
  readonly chatRetention: ChatRetentionChoice | undefined;
  /**
   * Content logging (`contentLogging`, 8.1): `Forbidden` means no app can switch prompts and answers into its logs, even for a time
   * (`FadenstackAgent.startContentLogging` throws). Absent: allowed, and the app and the person decide. .NET: `MachinePolicy.ContentLogging`.
   */
  readonly contentLogging: PolicyAccess;
  /**
   * How many days entries of the person's record of tool calls are kept (`auditRetentionDays`, 30 to 3650), fixed by IT; undefined: 180
   * days. A value out of bounds or not a whole number is reported and becomes 180. .NET: `MachinePolicy.AuditRetentionDays`.
   */
  readonly auditRetentionDays: number | undefined;
  /**
   * The address "Report a problem" writes to (`supportEmail`, sdk/0.3.1): one plain mail address, in both modes, and in governed mode the
   * only one the sheet uses. A value that is not one plain address (a `?`, `&`, `%`, `,`, a space, a line break, two addresses, over 254
   * characters) is reported in `warnings` (never the value) and counts as absent. Undefined: absent. .NET: `MachinePolicy.SupportEmail`.
   */
  readonly supportEmail: string | undefined;
  /** The keys the policy set itself (the app locks them in its UI and never writes them into the person's settings). */
  readonly locked: readonly string[];
  /** What was ignored or narrowed while reading: unknown keys, unknown values (never a value itself). */
  readonly warnings: readonly string[];

  constructor(init: MachinePolicyInit = {}) {
    this.server = init.server;
    this.standalone = init.standalone ?? PolicyAccess.Allowed;
    this.endpoints = init.endpoints === undefined || init.endpoints === null ? null : Object.freeze([...init.endpoints]);
    this.plainHttp = init.plainHttp ?? PolicyAccess.Allowed;
    this.mcp = init.mcp ?? PolicyRule.allowed;
    this.skills = init.skills ?? PolicyRule.allowed;
    this.webSearch = init.webSearch ?? PolicyAccess.Allowed;
    this.timestamping = init.timestamping ?? TimestampingPolicy.on;
    this.chatRetention = init.chatRetention;
    this.contentLogging = init.contentLogging ?? PolicyAccess.Allowed;
    this.auditRetentionDays = init.auditRetentionDays;
    this.supportEmail = isSupportEmail(init.supportEmail) ? init.supportEmail : undefined;
    this.locked = Object.freeze([...(init.locked ?? [])]);
    this.warnings = Object.freeze([...(init.warnings ?? [])]);
    Object.freeze(this);
  }

  /** Whether the policy allows a standalone agent on `baseUrl`: by its origin, or by the listed base it sits under exactly. */
  allowsEndpoint(baseUrl: string | URL): boolean {
    if (this.standalone !== PolicyAccess.Allowed) return false;
    if (this.endpoints === null) return true;
    const url = baseUrl instanceof URL ? baseUrl : new URL(baseUrl);
    const origin = url.origin.toLowerCase();
    const base = url.href.replace(/\/+$/, "").toLowerCase();
    return this.endpoints.some((entry) => {
      let allowed: URL;
      try {
        allowed = new URL(entry);
      } catch {
        return false;
      }
      return allowed.href.replace(/\/+$/, "").toLowerCase() === base || (allowed.pathname === "/" && allowed.origin.toLowerCase() === origin);
    });
  }

  /**
   * Reads a policy file's JSON. Never throws on a value: what it does not understand narrows and is reported. Text that is
   * not JSON at all throws a `SyntaxError`, as .NET's `FromJson` throws a `JsonException` (its `Load` catches that and
   * forbids; a caller of `fromJson` does the same, or uses `from` with the parsed object).
   */
  static fromJson(json: string): MachinePolicy {
    return MachinePolicy.from(JSON.parse(json) as unknown);
  }

  /** An administrator's policy the SDK cannot read: fail closed, as for an unknown value. */
  static #closed(why: string): MachinePolicy {
    return new MachinePolicy({
      standalone: PolicyAccess.Forbidden, plainHttp: PolicyAccess.Forbidden, mcp: PolicyRule.forbidden, skills: PolicyRule.forbidden,
      webSearch: PolicyAccess.Forbidden, timestamping: TimestampingPolicy.off, contentLogging: PolicyAccess.Forbidden,
      chatRetention: DEFAULT_CHAT_RETENTION, // old chats are deleted as by default; the person cannot turn it off
      auditRetentionDays: AuditRetention.defaultDays,
      locked: KEYS.filter((k) => k !== "server"),
      warnings: [`${why}: standalone, local MCP, local skills, web search and plain http are forbidden; time-stamps are off.`],
    });
  }

  /**
   * Reads a policy that is already an object (Chrome's `chrome.storage.managed.get()`, parsed JSON). Anything that is not a
   * plain object forbids what it could have allowed. .NET: `From(JsonElement)`.
   */
  static from(root: unknown): MachinePolicy {
    if (root === null || typeof root !== "object" || Array.isArray(root)) return MachinePolicy.#closed("The policy is not a JSON object");
    const warnings: string[] = [];
    const locked: string[] = [];
    const values = new Map<string, unknown>();
    for (const [name, value] of Object.entries(root)) {
      if (KEYS.includes(name)) {
        values.set(name, value);
        locked.push(name);
      } else {
        warnings.push(`Unknown key '${name}' ignored.`);
      }
    }
    let server: URL | undefined;
    if (values.has("server")) {
      const given = values.get("server");
      const url = typeof given === "string" ? parseUrl(given) : undefined;
      if (url && (url.protocol === "https:" || url.protocol === "http:")) server = url;
      else warnings.push("'server' is not an http(s) address: ignored.");
    }
    // R3-8: with a server, what the person could add on their own is forbidden unless the policy says otherwise.
    const byDefault = server ? PolicyAccess.Forbidden : PolicyAccess.Allowed;
    const byDefaultRule = server ? PolicyRule.forbidden : PolicyRule.allowed;
    return new MachinePolicy({
      server,
      standalone: access(values, "standalone", byDefault, warnings),
      endpoints: values.has("endpoints") ? strings(values.get("endpoints"), "endpoints", warnings) : null,
      plainHttp: access(values, "plainHttp", PolicyAccess.Allowed, warnings),
      mcp: rule(values, "mcp", byDefaultRule, warnings),
      skills: rule(values, "skills", byDefaultRule, warnings),
      webSearch: access(values, "webSearch", byDefault, warnings),
      timestamping: timestamps(values, warnings),
      chatRetention: values.has("chatRetention") ? retention(values.get("chatRetention"), warnings) : undefined,
      contentLogging: access(values, "contentLogging", PolicyAccess.Allowed, warnings),
      auditRetentionDays: values.has("auditRetentionDays") ? auditDays(values.get("auditRetentionDays"), warnings) : undefined,
      supportEmail: values.has("supportEmail") ? supportAddress(values.get("supportEmail"), warnings) : undefined,
      locked,
      warnings,
    });
  }
}

/** The machine policy refused what the app asked for (nothing was built). .NET: `MachinePolicyException`. */
export class MachinePolicyError extends FadenstackError {
  /** The policy key that refused it (`standalone`, `endpoints`, ...). */
  readonly key: string;

  constructor(key: string, message: string) {
    super(message);
    this.key = key;
  }
}

function parseUrl(text: string): URL | undefined {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}

function access(values: Map<string, unknown>, key: string, fallback: PolicyAccess, warnings: string[]): PolicyAccess {
  if (!values.has(key)) return fallback;
  const value = values.get(key);
  if (value === "allowed") return PolicyAccess.Allowed;
  if (value === "forbidden") return PolicyAccess.Forbidden;
  warnings.push(`'${key}' has a value the SDK does not know: forbidden.`);
  return PolicyAccess.Forbidden;
}

/** `on`, `off`, or an http(s) address without user info; anything else narrows to `off` (less leaves the device). .NET: `Timestamps`. */
function timestamps(values: Map<string, unknown>, warnings: string[]): TimestampingPolicy {
  if (!values.has("timestamping")) return TimestampingPolicy.on;
  const value = values.get("timestamping");
  const text = typeof value === "string" ? value.trim() : undefined;
  if (text === "on") return TimestampingPolicy.on;
  if (text === "off") return TimestampingPolicy.off;
  const server = text === undefined ? undefined : parseUrl(text);
  if (server && (server.protocol === "https:" || server.protocol === "http:") && server.username === "" && server.password === "") {
    return Object.freeze<TimestampingPolicy>({ mode: TimestampingMode.OwnServer, server });
  }
  warnings.push("'timestamping' is neither on, off nor an http(s) address: off.");
  return TimestampingPolicy.off;
}

/**
 * `{ "autoDelete": true, "maxAgeDays": 30, "maxSessions": 100 }`. What it leaves out is the default (on, 90 days, 50 chats); a value
 * that is not understood or out of bounds is reported and also becomes the default, so chats are not kept longer than that.
 */
function auditDays(value: unknown, warnings: string[]): number {
  if (typeof value === "number" && AuditRetention.isValid(value)) return value;
  warnings.push(`'auditRetentionDays' is not a whole number from ${AuditRetention.minDays} to ${AuditRetention.maxDays}: the default (${AuditRetention.defaultDays}).`);
  return AuditRetention.defaultDays;
}

/** One plain mail address, or nothing: a value that is not one is reported (never itself) and counts as absent (OWASP ASVS 5.0 V1). */
function supportAddress(value: unknown, warnings: string[]): string | undefined {
  if (isSupportEmail(value)) return value;
  warnings.push("'supportEmail' is not one plain mail address: ignored.");
  return undefined;
}

function retention(value: unknown, warnings: string[]): ChatRetentionChoice {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    warnings.push("'chatRetention' is not an object: the defaults (on, 90 days, 50 chats) apply.");
    return DEFAULT_CHAT_RETENTION;
  }
  let autoDelete = true;
  let days = DEFAULT_CHAT_RETENTION.maxAgeDays;
  let chats = DEFAULT_CHAT_RETENTION.maxSessions;
  for (const [name, member] of Object.entries(value)) {
    switch (name) {
      case "autoDelete":
        if (typeof member === "boolean") autoDelete = member;
        else warnings.push("'chatRetention.autoDelete' is not true or false: on.");
        break;
      case "maxAgeDays":
        if (isValidRetentionDays(member)) days = member;
        else warnings.push(`'chatRetention.maxAgeDays' is not a whole number within its bounds: the default (${days}).`);
        break;
      case "maxSessions":
        if (isValidRetentionChats(member)) chats = member;
        else warnings.push(`'chatRetention.maxSessions' is not a whole number within its bounds: the default (${chats}).`);
        break;
      default:
        warnings.push(`Unknown key 'chatRetention.${name}' ignored.`);
    }
  }
  return chatRetentionChoice({ autoDelete, maxAgeDays: days, maxSessions: chats });
}

function rule(values: Map<string, unknown>, key: string, fallback: PolicyRule, warnings: string[]): PolicyRule {
  if (!values.has(key)) return fallback;
  const value = values.get(key);
  if (Array.isArray(value)) return new PolicyRule(PolicyAccess.Listed, strings(value, key, warnings) ?? []);
  return access(values, key, PolicyAccess.Forbidden, warnings) === PolicyAccess.Allowed ? PolicyRule.allowed : PolicyRule.forbidden;
}

function strings(value: unknown, key: string, warnings: string[]): string[] {
  if (!Array.isArray(value)) {
    warnings.push(`'${key}' is not a list: nothing is allowed.`);
    return [];
  }
  const items: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.length > 0) items.push(item.trim());
    else warnings.push(`'${key}' holds an entry that is not text: left out.`);
  }
  return items;
}
