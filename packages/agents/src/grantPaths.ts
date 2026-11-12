import type { GrantTarget } from "@fadenstack/client";

/**
 * Where a stretch of work's places lead, as far as an SDK in a browser or a sandbox can tell (sdk/38 §6; ASVS 5.0 5.3.2,
 * file paths from untrusted input; CWE-59, link following). The gateway matches a call's place against the grant's by
 * their text: it cannot see that a link, a junction or a mount point on the device leads somewhere else. JavaScript here
 * has no file system to ask, so the host's `GrantPlaceResolver` resolves each place and each target as the operating
 * system does (every link on the way, in every part of the path; a file that does not exist yet below the real path of
 * the part that does), and this module compares the real paths. What cannot be resolved covers nothing: the person is
 * asked. .NET: `Fadenstack.Agents.GrantPaths` (`Lies`, `Named`, `IsLocal`).
 *
 * Not caught: a hard link (one file under two names, both real), and a link that changes between this check and the
 * tool's own opening of the path.
 */

/** Whether places of `type` may name a path on this device (an app by its executable's path). */
export function namesPath(type: GrantTarget["type"]): boolean {
  return type === "document" || type === "folder" || type === "app";
}

/** Whether `value` is a full path on a device, not a URL and not relative: `C:\x`, `C:/x`, `\\server\share`, `/x`. */
export function isLocalPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("/");
}

const windowsLike = (value: string) => /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");

// A root keeps its separator ("C:/", "/"); every other path loses a trailing one. Backslashes are separators only in a
// Windows path: elsewhere one is a letter of a name.
function trim(path: string): string {
  let value = windowsLike(path) ? path.replace(/\\/g, "/") : path;
  while (value.length > 1 && value.endsWith("/") && !/^[A-Za-z]:\/$/.test(value)) value = value.slice(0, -1);
  return value;
}

/**
 * Whether the real `place` is the real `target`, or for a folder lies under it. Both are canonical paths as the resolver
 * gives them: compared as they are, so a difference of case asks (the safe side) rather than covers.
 */
export function lies(type: GrantTarget["type"], target: string, place: string): boolean {
  const folder = trim(target), named = trim(place);
  if (folder === named) return true;
  if (type !== "folder") return false;
  const under = folder.endsWith("/") ? folder : `${folder}/`;
  return named.startsWith(under);
}

const slashed = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "");

function origin(value: string): string | undefined {
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    return url.hostname ? url.origin.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A place that names no path on a device (a site, a desk, an app by its name, a document by its URL or id), matched by
 * its text as the gateway does: documents, apps and desks by identity, folders by path, sites by origin.
 */
export function named(type: GrantTarget["type"], target: string, place: string): boolean {
  switch (type) {
    case "folder":
      return !place.replace(/\\/g, "/").split("/").includes("..")
        && `${slashed(place)}/`.toLowerCase().startsWith(`${slashed(target)}/`.toLowerCase());
    case "document":
      return slashed(place).toLowerCase() === slashed(target).toLowerCase();
    case "site": {
      const mine = origin(place);
      return mine !== undefined && mine === origin(target);
    }
    default:
      return place.toLowerCase() === target.toLowerCase();
  }
}
