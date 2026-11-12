import type { AgentPrincipal } from "@fadenstack/client";

/** Who the stores are kept for: the tenant and the user of the profile's principal. */
export type StorePrincipal = Pick<AgentPrincipal, "tenantId" | "userId">;

/**
 * The name of the IndexedDB database a signed-in user keeps their chats or "Allow always" in: `base` for a gateway that
 * names no user (the shared database an older SDK used), else the base with the tenant and the user, each escaped so that
 * no two users share a name. Two people who sign in one after the other in one browser profile never see each other's.
 * (39 F10; sdk/46 F1.)
 */
export function userStoreName(base: string, principal: StorePrincipal | undefined): string {
  return principal ? `${base}:${encodeURIComponent(principal.tenantId)}:${encodeURIComponent(principal.userId)}` : base;
}
