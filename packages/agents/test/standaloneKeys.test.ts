import { describe, expect, it } from "vitest";

import { toAgentPrincipal } from "../../client/src/models.js";
import { STANDALONE_PRINCIPAL, deletePersonalLocalEntries, personalLocalEntries, userLocalKey, userStoreName } from "../src/userData.js";

/** The person's own AI (standalone) and a governed server's user `standalone` must not share a store. OWASP ASVS 5.0 V8 (data separation). */
function governed(tenant: string, user: string) {
  return toAgentPrincipal({ tenant_id: tenant, user_id: user, agent_id: "a-1" })!;
}

function fakeStorage(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));
  return {
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    removeItem: (k: string) => { map.delete(k); },
    keys: () => [...map.keys()].sort(),
  };
}

describe("the standalone person's stores", () => {
  it("keep their names", () => {
    expect(userStoreName("fadenstack-sessions", STANDALONE_PRINCIPAL)).toBe("fadenstack-sessions:standalone:standalone");
    expect(userLocalKey("language", STANDALONE_PRINCIPAL)).toBe("fadenstack.language:standalone:standalone");
  });

  it("are not the stores of a governed user named standalone in a tenant named standalone", () => {
    const person = governed("standalone", "standalone");
    expect(person.userId).toBe("governed:standalone");
    const name = userStoreName("fadenstack-sessions", person);
    expect(name).toBe("fadenstack-sessions:standalone:governed:standalone");
    expect(name).not.toBe(userStoreName("fadenstack-sessions", STANDALONE_PRINCIPAL));
    expect(userStoreName("fadenstack-sessions", governed("standalone", "standalone"))).toBe(name); // deterministic
  });

  it("cannot be reached by an id that escapes to the same text", () => {
    // encodeURIComponent escapes a colon, so no id makes `governed:standalone` unescaped but this one.
    expect(userStoreName("b", { tenantId: "standalone", userId: "governed%3Astandalone" })).not.toBe(userStoreName("b", governed("standalone", "standalone")));
    expect(userStoreName("b", { tenantId: "standalone", userId: "governed standalone" })).not.toBe(userStoreName("b", governed("standalone", "standalone")));
  });

  it("are kept for other names: a user standalone in another tenant, Standalone, and any other id", () => {
    expect(governed("acme", "standalone").userId).toBe("standalone");
    expect(userStoreName("b", governed("acme", "standalone"))).toBe("b:acme:standalone");
    expect(governed("standalone", "Standalone").userId).toBe("Standalone");
    expect(userStoreName("b", governed("standalone", "Standalone"))).not.toBe(userStoreName("b", STANDALONE_PRINCIPAL));
    expect(userStoreName("b", governed("t-1", "u 1"))).toBe("b:t-1:u%201");
  });

  it("keep localStorage entries apart on export and delete", () => {
    const storage = fakeStorage({
      "fadenstack.language:standalone:standalone": "own",
      "fadenstack.language:standalone:governed:standalone": "server's",
    });
    const own = personalLocalEntries(storage, STANDALONE_PRINCIPAL);
    expect(own.map((e) => e.value)).toEqual(["own"]);
    expect(personalLocalEntries(storage, governed("standalone", "standalone")).map((e) => e.value)).toEqual(["server's"]);
    expect(deletePersonalLocalEntries(storage, governed("standalone", "standalone"))).toBe(1);
    expect(storage.keys()).toEqual(["fadenstack.language:standalone:standalone"]);
  });

  it("keep a marked person's entries from a tenant named governed, whose key ends the same way", () => {
    const storage = fakeStorage({
      "fadenstack.prompts:standalone:governed:standalone": "the marked person's",
      "fadenstack.prompts:governed:standalone": "tenant governed's",
    });
    const other = governed("governed", "standalone");
    expect(userLocalKey("prompts", other)).toBe("fadenstack.prompts:governed:standalone");
    expect(personalLocalEntries(storage, other).map((e) => [e.name, e.value])).toEqual([["prompts", "tenant governed's"]]);
    expect(deletePersonalLocalEntries(storage, other)).toBe(1);
    expect(storage.keys()).toEqual(["fadenstack.prompts:standalone:governed:standalone"]);
    expect(personalLocalEntries(storage, governed("standalone", "standalone")).map((e) => e.value)).toEqual(["the marked person's"]);
  });
});
