import type { ChatSession } from "./session.js";
import type { AgentContext, ChangingToolSource } from "./stages.js";
import { CORE_TOOL_SOURCE, FIND_TOOL_NAME, defineTool, refuseReservedToolNames, settleHostTools, type AgentTool, type ToolScope } from "./tools.js";

/** The name of the tool that finds the other tools: the SDK's own (an app's tool cannot take it). */
export { FIND_TOOL_NAME };
/** The most on-request tools in scope in one conversation; a new pick pushes out the least recently used. */
export const MAX_TOOLS_IN_SCOPE = 10;
/** The most tools one search switches on. */
export const MAX_FOUND = 5;

const SENTENCE =
  "Finds tools that are switched off in this conversation and switches the best matches on. "
  + "Call it with a few words about what you need; the tools it names can then be called with their parameters.";

export interface OnRequestToolsOptions {
  /** Lines for the description of `find_tool`: what the tools on request are about, one line per group. */
  index?: readonly string[];
}

/**
 * Host tools that are not offered by default. While any exist the model gets one tool, `find_tool`; a search switches the
 * best matches on for the rest of that conversation (at most `MAX_TOOLS_IN_SCOPE` at a time), and a tool called by name is
 * switched on as well (the call is answered, not run: "X is now switched on. Call it again"). A browser has no local MCP
 * process, so this is the same seam over the host's own tools. .NET: `LocalMcpModule`'s `find_tool` and conversation scope.
 *
 * The tools are host tools, `find_tool` too: the agent's contract vouches for their class and drops those it does not list,
 * exactly as for the tools given to the builder (`addTools`); the server learns of them from the app manifest. A tool that
 * asks, asks.
 * Add the source with `addToolSource`; `set` changes the tools, and the agent settles the change at the next turn.
 */
export class OnRequestTools implements ChangingToolSource {
  /** The SDK's own source: the only kind that brings `find_tool`. */
  readonly [CORE_TOOL_SOURCE] = true;
  readonly #listeners = new Set<() => void>();
  readonly #scopes = new Map<string, ConversationScope>();
  readonly #index: readonly string[];
  #declared: readonly AgentTool[];
  // The tools as the last `getTools` settled them, by name: the scope compares the agent's tool with this, by identity.
  #current = new Map<string, AgentTool>();
  readonly #scope: ToolScope = {
    offers: (tool, session) => tool.name === FIND_TOOL_NAME || this.#isOn(tool, session),
    beforeCall: (tool, session) => this.#beforeCall(tool, session),
  };

  /** `tools` are the app's: a name the SDK keeps for its own tools (`RESERVED_TOOL_NAMES`) is refused (`TypeError`). */
  constructor(tools: readonly AgentTool[] = [], options: OnRequestToolsOptions = {}) {
    refuseReservedToolNames(tools);
    this.#declared = [...tools];
    this.#index = [...(options.index ?? [])];
  }

  /** Replaces the tools on request; the agent asks for them again at the start of its next turn. Reserved names are refused. */
  set(tools: readonly AgentTool[]): void {
    refuseReservedToolNames(tools);
    this.#declared = [...tools];
    for (const listener of [...this.#listeners]) listener();
  }

  onChanged(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** The host tools this source brings, `find_tool` first: for the app manifest, which is how the server learns of them. */
  declared(): readonly AgentTool[] {
    const tools = this.#declared; // no reserved name: the constructor and set refuse them
    return tools.length ? [this.#findTool(), ...tools] : [];
  }

  async getTools(context: AgentContext): Promise<readonly AgentTool[]> {
    // The tools on request are host tools like any other: the contract vouches for their class and drops what it does not
    // list. find_tool is the SDK's: read, as the gateway takes it, unless the contract lists it (then its word); offered
    // while any tool on request is left to find.
    const [find, ...onRequest] = this.declared();
    const found = settleHostTools(onRequest, context.profile);
    if (!find || found.length === 0) {
      this.#current = new Map();
      return [];
    }
    const listed = context.profile.hostToolContract.some((t) => t.name === FIND_TOOL_NAME);
    const search = listed ? settleHostTools([find], context.profile) : [find];
    const settled = [...search, ...found].map((t): AgentTool => ({ ...t, scope: this.#scope }));
    this.#current = new Map(found.map((t) => [t.name, settled.find((s) => s.name === t.name)!]));
    return settled;
  }

  #findTool(): AgentTool {
    const description = this.#index.length ? `${SENTENCE}\nTools on request:\n${this.#index.join("\n")}` : SENTENCE;
    const find = defineTool<{ query: string }>({
      name: FIND_TOOL_NAME,
      description,
      toolClass: "read",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "A few words about what you need." } },
        required: ["query"],
      },
      run: ({ query }, context) => {
        const text = typeof query === "string" ? query.trim() : "";
        return text ? this.#find(context.sessionId, text.length > 500 ? text.slice(0, 500) : text)
          : "Error: give a few words about the tool you need as 'query'.";
      },
    });
    return { ...find, scope: this.#scope };
  }

  /** Runs a search for `find_tool`: switches the best matches on in the conversation and lists them. */
  #find(sessionId: string, query: string): string {
    const candidates = [...this.#current.values()];
    const ranked = rank(candidates.map((t) => ({ name: t.name, description: t.description ?? "" })), query, MAX_FOUND);
    if (ranked.length === 0) return "No tool matched that search. Try other words.";
    const found = ranked.map((i) => candidates[i]!);
    this.#scopeOf(sessionId).switchOn(found);
    const lines = found.map((t) => `${t.name}: ${oneLine(t.description ?? "", 120)}`).join("\n");
    return `Switched on ${found.length} tool${found.length === 1 ? "" : "s"} for this conversation. Call them with their parameters.\n${lines}`;
  }

  #isOn(tool: AgentTool, session: ChatSession): boolean {
    if (this.#current.get(tool.name) !== tool) return false; // gone, or changed since this list was made
    return this.#scopes.get(session.id)?.isOn(tool) === true;
  }

  #beforeCall(tool: AgentTool, session: ChatSession): string | undefined {
    if (tool.name === FIND_TOOL_NAME) return undefined;
    const current = this.#current.get(tool.name);
    if (!current) return `${tool.name} is no longer available.`;
    const scope = this.#scopeOf(session.id);
    if (current !== tool) {
      scope.switchOff(tool.name);
      return `${tool.name} changed its definition while you worked. Search for it again with ${FIND_TOOL_NAME}.`;
    }
    if (scope.isOn(current)) {
      scope.touch(current);
      return undefined;
    }
    scope.switchOn([current]);
    return `${tool.name} is now switched on. Call it again with its parameters.`;
  }

  #scopeOf(sessionId: string): ConversationScope {
    let scope = this.#scopes.get(sessionId);
    if (!scope) {
      scope = new ConversationScope();
      this.#scopes.set(sessionId, scope);
      // A device keeps few conversations open; the oldest scopes are forgotten, the person's search would be repeated.
      if (this.#scopes.size > 200) this.#scopes.delete(this.#scopes.keys().next().value!);
    }
    return scope;
  }
}

/** The on-request tools one conversation has switched on: at most `MAX_TOOLS_IN_SCOPE`, the least recently used out first. */
class ConversationScope {
  readonly #on = new Map<string, { tool: AgentTool; used: number }>();
  #clock = 0;

  isOn(tool: AgentTool): boolean {
    return this.#on.get(tool.name)?.tool === tool;
  }

  touch(tool: AgentTool): void {
    this.#on.set(tool.name, { tool, used: ++this.#clock });
  }

  switchOff(name: string): void {
    this.#on.delete(name);
  }

  /** Switches the tools on, the first of them as the most recently used; the cap pushes the oldest out. */
  switchOn(tools: readonly AgentTool[]): void {
    for (let i = tools.length - 1; i >= 0; i--) this.#on.set(tools[i]!.name, { tool: tools[i]!, used: ++this.#clock });
    while (this.#on.size > MAX_TOOLS_IN_SCOPE) {
      let oldest: string | undefined;
      for (const [name, entry] of this.#on) if (oldest === undefined || entry.used < this.#on.get(oldest)!.used) oldest = name;
      this.#on.delete(oldest!);
    }
  }
}

function oneLine(text: string, limit: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1).trimEnd()}…` : clean;
}

/** A plural ending dropped: `issues` and `branches` match `issue` and `branch`. */
function stem(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && (token.endsWith("ches") || token.endsWith("shes") || token.endsWith("sses") || token.endsWith("xes"))) {
    return token.slice(0, -2);
  }
  return token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token;
}

/** Lower-case words: split at anything that is not a letter or digit and at camelCase; a plural `s` is dropped. */
function tokens(text: string): string[] {
  const out: string[] = [];
  let word = "";
  const flush = () => {
    if (!word) return;
    const token = stem(word.toLowerCase());
    word = "";
    if (token.length >= 2 || /\d/.test(token[0]!)) out.push(token);
  };
  for (const c of [...text]) {
    const letter = /[\p{L}\p{N}]/u.test(c);
    if (!letter || (word && /\p{Lu}/u.test(c) && /\p{Ll}/u.test(word[word.length - 1]!))) flush();
    if (letter) word += c;
  }
  flush();
  return out;
}

/**
 * BM25 over tools' names and descriptions: the indexes of the best matches for `query` first, those that share at least one
 * word with it. A name counts double. (.NET `McpText.Rank`.)
 */
export function rank(documents: readonly { name: string; description: string }[], query: string, take: number): number[] {
  const terms = [...new Set(tokens(query))];
  if (terms.length === 0 || documents.length === 0) return [];
  const docs = documents.map((d) => [...tokens(d.name), ...tokens(d.name), ...tokens(d.description)]);
  const average = docs.reduce((sum, t) => sum + t.length, 0) / docs.length;
  const k1 = 1.2, b = 0.75;
  const scores: { index: number; score: number }[] = [];
  docs.forEach((doc, index) => {
    let score = 0;
    for (const term of terms) {
      const frequency = doc.filter((t) => t === term).length;
      if (frequency === 0) continue;
      const containing = docs.filter((t) => t.includes(term)).length;
      const idf = Math.log(1 + (docs.length - containing + 0.5) / (containing + 0.5));
      score += idf * frequency * (k1 + 1) / (frequency + k1 * (1 - b + b * doc.length / Math.max(average, 1)));
    }
    if (score > 0) scores.push({ index, score });
  });
  return scores
    .sort((a, b2) => b2.score - a.score || (documents[a.index]!.name < documents[b2.index]!.name ? -1 : documents[a.index]!.name > documents[b2.index]!.name ? 1 : 0))
    .slice(0, take).map((s) => s.index);
}
