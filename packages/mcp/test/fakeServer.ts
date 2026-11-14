import { McpServer, WebStandardStreamableHTTPServerTransport, createMcpHandler } from "@modelcontextprotocol/server";
import * as z from "zod";

/** What the fake server saw of one request. */
export interface Seen {
  method: string;
  path: string;
  headers: Record<string, string>;
  /** The JSON-RPC method of a POST (`initialize`, `server/discover`, `tools/list`, `tools/call`), if there is a body. */
  rpc?: string;
}

export interface FakeToolSpec {
  name: string;
  description?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  openWorldHint?: boolean;
  /** What it answers; the default echoes `text`. */
  answer?: (args: { text: string }) => string | Promise<string>;
}

export const DEFAULT_TOOLS: FakeToolSpec[] = [
  { name: "echo", description: "Echo the text back", readOnlyHint: true, answer: ({ text }) => `echo:${text}` },
  { name: "delete_file", description: "Delete a file", destructiveHint: true, answer: ({ text }) => `deleted:${text}` },
  { name: "write_note", description: "Write a note", answer: ({ text }) => `wrote:${text}` },
];

export interface FakeServerOptions {
  tools?: FakeToolSpec[];
  /** The first line of the instructions the server gives. */
  instructions?: string;
  /** Answers 401 to every request that lacks this exact `Authorization` header. */
  requireAuthorization?: string;
}

/**
 * A small MCP server in the process, as a `fetch`: no socket is opened. `/mcp` speaks both revisions (2026-07-28 and 2025-11-25,
 * without a session); `/legacy` speaks 2025-11-25 only, with a session, so a client that probes for 2026-07-28 has to fall back.
 * Built on `@modelcontextprotocol/server` 2.4.0, the same package family as the client.
 */
export class FakeMcpServer {
  readonly seen: Seen[] = [];
  readonly calls: { tool: string; args: unknown }[] = [];
  readonly origin = "http://127.0.0.1:8931";
  readonly #options: FakeServerOptions;
  readonly #modern: { fetch(request: Request): Promise<Response> };
  readonly #sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();

  constructor(options: FakeServerOptions = {}) {
    this.#options = options;
    this.#modern = createMcpHandler(() => this.#build());
  }

  get urls(): { both: string; legacy: string } {
    return { both: `${this.origin}/mcp`, legacy: `${this.origin}/legacy` };
  }

  #build(): McpServer {
    const server = new McpServer(
      { name: "fake-server", version: "1.0.0" },
      this.#options.instructions ? { instructions: this.#options.instructions } : {},
    );
    for (const spec of this.#options.tools ?? DEFAULT_TOOLS) {
      server.registerTool(
        spec.name,
        {
          description: spec.description ?? spec.name,
          inputSchema: z.object({ text: z.string() }),
          annotations: {
            ...(spec.readOnlyHint !== undefined ? { readOnlyHint: spec.readOnlyHint } : {}),
            ...(spec.destructiveHint !== undefined ? { destructiveHint: spec.destructiveHint } : {}),
            ...(spec.openWorldHint !== undefined ? { openWorldHint: spec.openWorldHint } : {}),
          },
        },
        async (args: { text: string }) => {
          this.calls.push({ tool: spec.name, args });
          const text = spec.answer ? await spec.answer(args) : `${spec.name}:${args.text}`;
          return { content: [{ type: "text" as const, text }] };
        },
      );
    }
    return server;
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => { headers[key] = value; });
    const seen: Seen = { method: request.method, path: url.pathname, headers };
    this.seen.push(seen);
    const need = this.#options.requireAuthorization;
    if (need !== undefined && headers["authorization"] !== need) return new Response("unauthorized", { status: 401 });
    if (request.method === "POST") {
      try {
        const body = (await request.clone().json()) as { method?: string };
        if (typeof body.method === "string") seen.rpc = body.method;
      } catch { /* not JSON: the server answers */ }
    }
    if (url.pathname === "/mcp") return this.#modern.fetch(request);
    if (url.pathname === "/legacy") return this.#legacy(request);
    return new Response("not found", { status: 404 });
  };

  async #legacy(request: Request): Promise<Response> {
    const id = request.headers.get("mcp-session-id");
    let transport = id ? this.#sessions.get(id) : undefined;
    if (!transport) {
      const made: WebStandardStreamableHTTPServerTransport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (session: string) => { this.#sessions.set(session, made); },
      });
      await this.#build().connect(made);
      transport = made;
    }
    return transport.handleRequest(request);
  }

  /** The JSON-RPC methods the server saw, in order. */
  get rpcs(): string[] {
    return this.seen.flatMap((s) => (s.rpc ? [s.rpc] : []));
  }
}
