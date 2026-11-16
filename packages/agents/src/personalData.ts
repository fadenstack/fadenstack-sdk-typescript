import { userStoreName, type StorePrincipal } from "./userData.js";

/**
 * Reads the person's other IndexedDB databases for the export (GDPR Art. 15 and 20), generically by name: this package does
 * not know the packages that write them (`@fadenstack/skills`, `@fadenstack/mcp`, `@fadenstack/provenance`). Each database and
 * object store is on an allowlist, so a store or a key that comes later is never handed over by accident:
 *
 * - `fadenstack-preferences`: every object store (the thinking level and anything else the person picked);
 * - `fadenstack-apps`: the app records (names, agent slugs, times);
 * - `fadenstack-skills` and `fadenstack-skill-switches`: the person's own text and what they turned off;
 * - `fadenstack-provenance`: the `records` and the `placements` log, never the `keys` store (the device's signing key);
 * - `fadenstack-mcp`: the `servers` without their sealed header values and with each field named below only, and the `audit` log;
 * - `fadenstack-web-search`: the provider and the SearXNG address, never the `key` store (the sealed Brave key);
 * - `fadenstack-keys`: never.
 *
 * Nothing that is not plain JSON data goes in (a `CryptoKey`, a `Uint8Array`, a `Blob`, a `Date`): such a record is counted as
 * unreadable. Nothing here throws: what cannot be read is counted.
 */
export interface PersonalDatabases {
  /** Database (its base name without `fadenstack-`) to object store to its rows. */
  databases: Record<string, Record<string, unknown[]>>;
  /** How many of the allowlisted databases existed. */
  found: number;
  /** How many rows went in. */
  records: number;
  /** How many rows (or stores, or databases) could not be read or were not plain data. */
  unreadable: number;
}

type RowMap = (value: unknown) => unknown | undefined;

interface Allowed {
  base: string;
  /** The name in the export. */
  as: string;
  /** The object stores that may be read, with how a row is cleaned; `"*"`: every store, rows as they are. */
  stores: "*" | Record<string, RowMap | null>;
}

const ALLOWED: readonly Allowed[] = [
  { base: "fadenstack-preferences", as: "preferences", stores: "*" },
  { base: "fadenstack-apps", as: "apps", stores: "*" }, // which apps use the person's data: names, agent slugs and times
  { base: "fadenstack-skills", as: "skills", stores: { skills: null } },
  { base: "fadenstack-skill-switches", as: "skill-switches", stores: "*" },
  { base: "fadenstack-provenance", as: "provenance", stores: { records: null, placements: null } }, // never `keys`
  { base: "fadenstack-mcp", as: "mcp", stores: { servers: mcpServer, audit: null } },
  { base: "fadenstack-web-search", as: "web-search", stores: { settings: null } }, // never `key` (the sealed Brave key)
];

/** What a plain JSON value is: null, a boolean, a finite number, a string, an array or an object of those. */
export function isPlainData(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((v) => isPlainData(v, depth + 1));
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value as Record<string, unknown>).every((v) => isPlainData(v, depth + 1));
  }
  return false;
}

/** The address without a user, a password, a query or a fragment (tokens are often put there); undefined where it does not parse as http(s). */
export function safeAddress(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

/**
 * An MCP server as the export gets it: the fields named here and no other, so that a secret added to the record later never
 * goes out. `sealed` (the header values) is not among them; of the headers only their names are.
 */
function mcpServer(value: unknown): unknown | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (typeof row["label"] === "string") out["label"] = row["label"];
  const url = safeAddress(row["url"]);
  if (url !== undefined) out["url"] = url;
  for (const key of ["enabled", "trusted", "reviewed", "plainHttpInLan"]) if (typeof row[key] === "boolean") out[key] = row[key];
  if (typeof row["callTimeoutS"] === "number" && Number.isFinite(row["callTimeoutS"])) out["callTimeoutS"] = row["callTimeoutS"];
  if (typeof row["importedFrom"] === "string") out["importedFrom"] = row["importedFrom"];
  const classes = row["toolClasses"];
  if (classes !== null && typeof classes === "object" && !Array.isArray(classes)) {
    const kept: Record<string, string> = {};
    for (const [tool, cls] of Object.entries(classes)) if (cls === "read" || cls === "write") kept[tool] = cls;
    out["toolClasses"] = kept;
  }
  const names = row["headerNames"];
  if (Array.isArray(names)) out["headerNames"] = names.filter((n): n is string => typeof n === "string");
  return out;
}

function request<T>(req: IDBRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed."));
  });
}

/** Whether the database exists, without making it: `databases()` where the browser has it, else an open that is rolled back. */
async function exists(factory: IDBFactory, name: string): Promise<boolean> {
  if (typeof factory.databases === "function") return (await factory.databases()).some((d) => d.name === name);
  return new Promise<boolean>((resolve) => {
    const open = factory.open(name);
    let created = false;
    open.onupgradeneeded = () => {
      created = true;
      open.transaction?.abort(); // it did not exist: nothing is made
    };
    open.onsuccess = () => {
      open.result.close();
      resolve(!created);
    };
    open.onerror = () => resolve(false);
    open.onblocked = () => resolve(false);
  });
}

/** One database's allowlisted stores; undefined when it could not be opened. */
async function readDatabase(factory: IDBFactory, name: string, allowed: Allowed, into: PersonalDatabases): Promise<Record<string, unknown[]> | undefined> {
  const db = await new Promise<IDBDatabase | undefined>((resolve) => {
    const open = factory.open(name);
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => resolve(undefined);
    open.onblocked = () => resolve(undefined);
  });
  if (!db) return undefined;
  try {
    const stores: Record<string, unknown[]> = {};
    const wanted = allowed.stores === "*" ? [...db.objectStoreNames] : Object.keys(allowed.stores).filter((s) => db.objectStoreNames.contains(s));
    for (const store of wanted) {
      const clean = allowed.stores === "*" ? null : allowed.stores[store] ?? null;
      try {
        const tx = db.transaction([store], "readonly");
        const os = tx.objectStore(store);
        const keyed = os.keyPath === null;
        const [values, keys] = await Promise.all([request<unknown[]>(os.getAll()), keyed ? request<IDBValidKey[]>(os.getAllKeys()) : Promise.resolve([] as IDBValidKey[])]);
        const rows: unknown[] = [];
        values.forEach((raw, i) => {
          const value = clean ? clean(raw) : raw;
          const key = keyed ? keys[i] : undefined;
          if (value === undefined || !isPlainData(value) || (keyed && typeof key !== "string" && typeof key !== "number")) {
            into.unreadable++;
            return;
          }
          rows.push(keyed ? { key, value } : value);
        });
        stores[store] = rows;
        into.records += rows.length;
      } catch {
        into.unreadable++; // the store could not be read
      }
    }
    return stores;
  } finally {
    db.close();
  }
}

/** The person's allowlisted databases (see `PersonalDatabases`); where there is no IndexedDB, nothing. */
export async function readPersonalDatabases(principal: StorePrincipal | undefined, factory: IDBFactory | undefined = globalThis.indexedDB): Promise<PersonalDatabases> {
  const result: PersonalDatabases = { databases: {}, found: 0, records: 0, unreadable: 0 };
  if (!factory) return result;
  for (const allowed of ALLOWED) {
    const name = userStoreName(allowed.base, principal);
    try {
      if (!(await exists(factory, name))) continue;
      const stores = await readDatabase(factory, name, allowed, result);
      if (!stores) {
        result.unreadable++;
        continue;
      }
      result.found++;
      result.databases[allowed.as] = stores;
    } catch {
      result.unreadable++;
    }
  }
  return result;
}
