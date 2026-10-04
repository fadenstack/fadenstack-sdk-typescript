import { FadenUnreachableError } from "../errors.js";
import { toApiError } from "../http/errorReader.js";
import type { FetchLike } from "../http/transport.js";

/** An agent definition as `POST /api/agents` takes it -- what an app ships in its `contracts/*.json`. */
export interface AgentDefinition {
  slug: string;
  name: string;
  description?: string | null;
  version?: Record<string, unknown>;
}

export interface CreateAgentOptions {
  apiUrl: string | URL;
  /** The user's login token (`loginWithPassword`): creating takes `agents:create`, which an agent token never has. */
  loginToken: string;
  definition: AgentDefinition;
  fetch?: FetchLike;
  signal?: AbortSignal;
}

export interface ListModelsOptions {
  serverUrl: string | URL;
  /** The user's login token: the plain routes take it. */
  loginToken: string;
  fetch?: FetchLike;
  signal?: AbortSignal;
}

/**
 * The chat models the server offers the user (`GET /v1/models`), for someone about to create an agent: the apps
 * leave the model to the agent, so one created without a model cannot answer.
 */
export async function listModels(options: ListModelsOptions): Promise<string[]> {
  const base = new URL(options.serverUrl);
  const url = new URL("v1/models", base.href.endsWith("/") ? base : `${base.href}/`);
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  let response: Response;
  try {
    const init: RequestInit = { headers: { accept: "application/json", authorization: `Bearer ${options.loginToken}` } };
    if (options.signal) init.signal = options.signal;
    response = await fetchImpl(url, init);
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    throw new FadenUnreachableError(`Fadenstack could not be reached: ${(error as Error).message}`, { cause: error });
  }
  const text = await response.text();
  if (!response.ok) throw toApiError(response, text);
  const data = (JSON.parse(text) as { data?: { id?: unknown }[] }).data ?? [];
  return data.map((m) => String(m.id ?? "")).filter(Boolean);
}

/** The agent as the server made it. */
export interface CreatedAgent {
  id: string;
  slug: string;
  name: string;
  status: string;
}

/**
 * Creates the agent on the server from the app's own definition, as a draft its creator maintains -- and so may
 * use at once. Publishing it and granting it to others stays in the console. For an app that finds the server
 * without its agent and is signed in by someone with `agents:create` (otherwise 403).
 */
export async function createAgent(options: CreateAgentOptions): Promise<CreatedAgent> {
  const base = new URL(options.apiUrl);
  const url = new URL("api/agents", base.href.endsWith("/") ? base : `${base.href}/`);
  const fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  let response: Response;
  try {
    const init: RequestInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${options.loginToken}`,
      },
      body: JSON.stringify(options.definition),
    };
    if (options.signal) init.signal = options.signal;
    response = await fetchImpl(url, init);
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    throw new FadenUnreachableError(`Fadenstack could not be reached: ${(error as Error).message}`, { cause: error });
  }
  const text = await response.text();
  if (!response.ok) throw toApiError(response, text);
  const body = JSON.parse(text) as Record<string, unknown>;
  return { id: String(body["id"] ?? ""), slug: String(body["slug"] ?? ""), name: String(body["name"] ?? ""), status: String(body["status"] ?? "") };
}
