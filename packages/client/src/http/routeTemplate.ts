/**
 * A request's route as it may be logged: the path without its query, with every segment that is not a plain lower-case word
 * (an id, a file name, anything with a digit or a capital) replaced by `{id}`: `/v1/sessions/{id}/messages`. The .NET SDK's
 * `RouteTemplate` does the same, so both log the same `Route` field. Ids and names stay out of the log, and so does a key
 * that some proxies keep in an endpoint's base path (the browser log and "Copy details" carry the route).
 */
export function routeTemplate(url: URL): string {
  const segments = url.pathname.split("/").filter((segment) => segment.length > 0).map((segment) => (isWord(segment) ? segment : "{id}"));
  return "/" + segments.join("/");
}

/** A name of the API (`agents`, `agent-tokens`, `v1`), or an agent's slug without digits. */
function isWord(segment: string): boolean {
  if (segment.length === 0 || segment.length > 40) return false;
  if (/^v[0-9]+$/.test(segment)) return true;
  return /^[a-z_-]+$/.test(segment);
}
