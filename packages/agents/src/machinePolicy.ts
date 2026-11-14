import { FadenstackError } from "@fadenstack/client";

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
  locked?: readonly string[];
  warnings?: readonly string[];
}

const KEYS: readonly string[] = Object.freeze(["server", "standalone", "endpoints", "plainHttp", "mcp", "skills", "webSearch", "timestamping"]);

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
  static #unreadable(why: string): MachinePolicy {
    return new MachinePolicy({
      standalone: PolicyAccess.Forbidden, plainHttp: PolicyAccess.Forbidden, mcp: PolicyRule.forbidden, skills: PolicyRule.forbidden,
      webSearch: PolicyAccess.Forbidden,
      warnings: [`${why}: standalone, local MCP, local skills, web search and plain http are forbidden.`],
    });
  }

  /**
   * Reads a policy that is already an object (Chrome's `chrome.storage.managed.get()`, parsed JSON). Anything that is not a
   * plain object forbids what it could have allowed. .NET: `From(JsonElement)`.
   */
  static from(root: unknown): MachinePolicy {
    if (root === null || typeof root !== "object" || Array.isArray(root)) return MachinePolicy.#unreadable("The policy is not a JSON object");
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
