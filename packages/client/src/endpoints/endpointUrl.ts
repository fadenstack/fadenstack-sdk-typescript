/**
 * The routes of an OpenAI-compatible endpoint, relative to its base (which includes `/v1`, the OpenAI convention):
 * `{base}/chat/completions` and `{base}/models`, with or without a trailing slash on the base. Azure OpenAI's v1 API is the
 * same shape under `https://{resource}.openai.azure.com/openai/v1`. Never the transport's `gateway()`, which puts `v1/...`
 * under the server and would double it here. .NET: `EndpointUrl`.
 */

/** The base with exactly one trailing slash; throws a `TypeError` for anything but an absolute http(s) URL without query, fragment or user info. */
export function endpointBase(baseUrl: string | URL): URL {
  const text = baseUrl instanceof URL ? baseUrl.href : String(baseUrl);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new TypeError("An endpoint's address is an absolute http or https URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TypeError("An endpoint's address is an absolute http or https URL.");
  if (/[?#]/.test(text)) {
    throw new TypeError("An endpoint's address has no query or fragment: give its base, such as https://host/v1.");
  }
  if (url.username !== "" || url.password !== "") {
    // A key in the address would be written wherever the address is (settings, logs): it goes into the key provider.
    throw new TypeError("An endpoint's address carries no user name or password: give the key separately.");
  }
  return new URL(`${url.pathname.replace(/\/+$/, "")}/`, url.origin);
}

/** `{base}/chat/completions`. */
export function endpointChatCompletions(baseUrl: string | URL): URL {
  return endpointRoute(baseUrl, "chat/completions");
}

/** `{base}/models`. */
export function endpointModels(baseUrl: string | URL): URL {
  return endpointRoute(baseUrl, "models");
}

/** A route under the base: `endpointRoute(base, "models")`. */
export function endpointRoute(baseUrl: string | URL, relative: string): URL {
  return new URL(relative.replace(/^\/+/, ""), endpointBase(baseUrl));
}

/**
 * A route at the server's root rather than under the OpenAI base: Ollama's `/api/show`, vLLM's `/version`, LM Studio's
 * `/api/v0/models/{model}`. The base's last `/v1` (and anything after it) is left out; a base without one keeps its path.
 */
export function endpointRoot(baseUrl: string | URL, relative: string): URL {
  const base = endpointBase(baseUrl);
  const path = base.pathname;
  const at = path.toLowerCase().lastIndexOf("/v1/");
  const root = at >= 0 ? path.slice(0, at + 1) : path;
  return new URL(relative.replace(/^\/+/, ""), new URL(root, base.origin));
}

/** The origin (scheme, host, port) a key may go to: requests and redirects never leave it. */
export function endpointOrigin(url: string | URL): string {
  return new URL(url).origin.toLowerCase();
}
