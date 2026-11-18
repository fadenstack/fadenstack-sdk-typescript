import { GOVERNED_USER_MARKER, type AgentPrincipal } from "@fadenstack/client";

/** Who the stores are kept for: the tenant and the user of the profile's principal. */
export type StorePrincipal = Pick<AgentPrincipal, "tenantId" | "userId">;

/**
 * The name of the IndexedDB database a signed-in user keeps their chats or "Allow always" in: `base` for a gateway that
 * names no user (the shared database an older SDK used), else the base with the tenant and the user, each escaped so that
 * no two users share a name. Two people who sign in one after the other in one browser profile never see each other's.
 * (39 F10; sdk/46 F1.)
 */
export function userStoreName(base: string, principal: StorePrincipal | undefined): string {
  return principal ? `${base}:${encodeURIComponent(principal.tenantId)}:${userSegment(principal.userId)}` : base;
}

/**
 * The user's part of a store name. A user id that starts with `GOVERNED_USER_MARKER` (the client gives it to a governed person
 * whose tenant and user are both `standalone`, the standalone principal's own pair) keeps the marker's colon unescaped,
 * and `encodeURIComponent` always escapes a colon: no other id can make the same name, `standalone` included.
 */
function userSegment(userId: string): string {
  return userId.startsWith(GOVERNED_USER_MARKER) ? GOVERNED_USER_MARKER + encodeURIComponent(userId.slice(GOVERNED_USER_MARKER.length)) : encodeURIComponent(userId);
}

/** The standalone principal (`LocalBackend`'s): the person of an app without a Fadenstack server. Its data is apart from any governed person's. */
export const STANDALONE_PRINCIPAL: StorePrincipal = Object.freeze({ tenantId: "standalone", userId: "standalone" } as StorePrincipal);

/**
 * The `localStorage` key a person's choice is kept under: `fadenstack.<name>` for a server that names no user (the one key every
 * person of the browser profile shared before), else the name with the tenant and the user, each escaped as `userStoreName` does.
 * `@fadenstack/ui-web`'s `browserPreferences()` and `browserPromptStore()` write under it; `deleteMyData` removes it.
 */
export function userLocalKey(name: string, principal: StorePrincipal | undefined): string {
  return userStoreName(`fadenstack.${name}`, principal);
}

/** The names the helpers of `@fadenstack/ui-web` keep in `localStorage` before the person's own keys existed (the shared, older keys). */
export const SHARED_LOCAL_NAMES: readonly string[] = Object.freeze(["language", "unmarkedNotice", "prompts"]);

/** One `localStorage` entry of a person: its name without the `fadenstack.` prefix and the person's part, its key, and its text. */
export interface PersonalLocalEntry {
  name: string;
  key: string;
  value: string;
  /** True for a key of the older, shared kind that only the standalone principal adopts (`userLocalKey` with no person). */
  shared: boolean;
}

/**
 * The person's `localStorage` entries: their own keys (`fadenstack.<name>:<tenant>:<user>`), and for the standalone principal
 * the shared keys of the earlier SDK too, which the helpers adopt once (see `browserPromptStore`), so an export or a deletion
 * that left them would hand over or keep what the person believes gone. A server that names no user: the shared keys are its own.
 * Never throws: storage that refuses is empty.
 */
export function personalLocalEntries(storage: Pick<Storage, "length" | "key" | "getItem"> | undefined, principal: StorePrincipal | undefined): PersonalLocalEntry[] {
  const found: PersonalLocalEntry[] = [];
  if (!storage) return found;
  try {
    const suffix = principal ? userStoreName("", principal) : undefined; // ":<tenant>:<user>", escaped
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key !== null) keys.push(key);
    }
    const prefix = "fadenstack.";
    for (const key of keys.sort()) {
      if (!key.startsWith(prefix)) continue;
      let name: string | undefined;
      let shared = false;
      if (suffix !== undefined) {
        if (key.endsWith(suffix) && key.length > prefix.length + suffix.length) name = key.slice(prefix.length, key.length - suffix.length);
        else if (isStandalone(principal) && SHARED_LOCAL_NAMES.includes(key.slice(prefix.length))) { name = key.slice(prefix.length); shared = true; }
      } else if (SHARED_LOCAL_NAMES.includes(key.slice(prefix.length))) {
        name = key.slice(prefix.length);
        shared = true;
      }
      if (name === undefined) continue;
      const value = storage.getItem(key);
      if (value !== null) found.push({ name, key, value, shared });
    }
  } catch {
    // storage that refuses to be read has nothing to hand over
  }
  return found;
}

function isStandalone(principal: StorePrincipal | undefined): boolean {
  return principal?.tenantId === STANDALONE_PRINCIPAL.tenantId && principal.userId === STANDALONE_PRINCIPAL.userId;
}

/** Removes the person's `localStorage` entries (`personalLocalEntries`); how many. Never throws. */
export function deletePersonalLocalEntries(storage: Pick<Storage, "length" | "key" | "getItem" | "removeItem"> | undefined, principal: StorePrincipal | undefined): number {
  let removed = 0;
  for (const entry of personalLocalEntries(storage, principal)) {
    try {
      storage!.removeItem(entry.key);
      removed++;
    } catch {
      // not removable: left, and not counted
    }
  }
  return removed;
}

/** `globalThis.localStorage`, or undefined where there is none or access is denied. */
export function pageLocalStorage(): Storage | undefined {
  try {
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    if (!storage) return undefined;
    storage.getItem("fadenstack.probe");
    return storage;
  } catch {
    return undefined;
  }
}
