import type { StorePrincipal } from "@fadenstack/agents";

/**
 * Whose choices a store keeps, asked at every use: the principal of the agent's profile once it has started (undefined inside:
 * a server that names no user), and `undefined` itself until then, when it is not known whose they are. The chat gives it to the
 * stores that follow the person, so that they keep the choices of the person who is signed in (and follow a sign-in as another).
 */
export type PersonSource = () => { principal: StorePrincipal | undefined } | undefined;

/** A `PreferenceStore` or `PromptStore` that keeps its data per person: `browserPreferences()` and `browserPromptStore()` in `@fadenstack/ui-web`. */
export interface FollowsPerson {
  followPerson(source: PersonSource): void;
}

export function followsPerson(store: unknown): store is FollowsPerson {
  return typeof (store as Partial<FollowsPerson> | null | undefined)?.followPerson === "function";
}
