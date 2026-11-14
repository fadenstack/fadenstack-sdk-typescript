import { effectiveToolClass, parseToolClass } from "@fadenstack/client";
import type { AgentProfile, EditKind, JsonSchema, ToolClass, ToolDefinition } from "@fadenstack/client";

import type { ChatSession } from "./session.js";

/**
 * The name of the SDK's tool search (`OnRequestTools`; .NET: the local MCP module's), kept for the SDK: an app's tool
 * cannot take it. It only switches tools on for the conversation, so a Fadenstack gateway takes it as read, and the tools
 * it finds ask on their own calls (sdk/51, the owner, 13 Nov 2026).
 */
export const FIND_TOOL_NAME = "find_tool";

/**
 * The names the SDK keeps for its own tools (sdk/52 §10.5, the owner, 14 Nov 2026): `find_tool` (the tool search),
 * `load_skill`, `read_skill_resource` and `run_skill_script` (skills on the device; scripts are never offered), and
 * `web_search`. A Fadenstack gateway gives these names the class of the SDK's own tool, so no app's tool may carry one:
 * `addTools` and `OnRequestTools` refuse it, and an app's tool source that brings one has it left out. Only the SDK's own
 * sources bring them. The .NET SDK's `AgentTool.ReservedNames`.
 */
export const RESERVED_TOOL_NAMES: readonly string[] = Object.freeze([
  FIND_TOOL_NAME, "load_skill", "read_skill_resource", "run_skill_script", "web_search",
]);

/** Whether `name` is one the SDK keeps for its own tools (`RESERVED_TOOL_NAMES`). */
export function isReservedToolName(name: string): boolean {
  return RESERVED_TOOL_NAMES.includes(name);
}

/** Throws for an app's tool under a name the SDK keeps for itself: the builder's and `OnRequestTools`' check. */
export function refuseReservedToolNames(tools: readonly { readonly name: string }[]): void {
  for (const tool of tools) {
    if (isReservedToolName(tool.name)) {
      throw new TypeError(
        `'${tool.name}' is a name the SDK keeps for its own tools (${RESERVED_TOOL_NAMES.join(", ")}), so an app's tool cannot take it: name it differently.`);
    }
  }
}

/** Marks one of the SDK's own tool sources, the only kind that may bring `FIND_TOOL_NAME`. Not exported from the package. */
export const CORE_TOOL_SOURCE: unique symbol = Symbol("fadenstack.coreToolSource");

/** Whether `source` is one of the SDK's own tool sources. */
export function isCoreToolSource(source: unknown): boolean {
  return typeof source === "object" && source !== null && (source as { [CORE_TOOL_SOURCE]?: unknown })[CORE_TOOL_SOURCE] === true;
}

/** What a running tool knows about its call. */
export interface ToolCallContext {
  /** Aborted when the turn is stopped. */
  signal: AbortSignal;
  callId: string;
  sessionId: string;
  turnId: string;
  /** What modules give tools for this call (`AgentBuilder.addToolService`): `context.services.get(Provenance)`. */
  services: ToolServices;
}

/**
 * A typed key for a service modules give tools per call: `const Provenance = toolServiceKey<Provenance>("provenance")`.
 * Keys are compared by identity, so two modules cannot take each other's service by its name.
 */
export interface ToolServiceKey<T> {
  /** For messages only. */
  readonly name: string;
  /** Carries the service's type for the compiler; never set. */
  readonly __service?: T;
}

export function toolServiceKey<T>(name: string): ToolServiceKey<T> {
  if (!name?.trim()) throw new TypeError("A tool service key needs a name.");
  return Object.freeze({ name });
}

/** The services a call can use, by key. */
export interface ToolServices {
  /** The service for this call, made on first use, once per call; undefined when no module gives it. */
  get<T>(key: ToolServiceKey<T>): T | undefined;
}

/** No services: for a tool run outside an agent's session. */
export const NO_TOOL_SERVICES: ToolServices = Object.freeze({ get: () => undefined });

/**
 * What a tool writes for people to read: the argument that carries it, its media type, and what kind of edit it is
 * (or a function of the call's arguments, for a tool that decides per call). Metadata only: the provenance module
 * reads it to check that the content went through its `place()`, and the app manifest reports it.
 */
export interface ToolOutput<A = Record<string, unknown>> {
  /** The argument with the content (`text`). */
  argument: string;
  /** Its media type: `text/markdown`, `text/html`, `text/plain`, `image/png`. */
  mediaType: string;
  /**
   * `generated`, `rewritten`, `summarised` (marked); `translated`, `corrected`, `formatted`, `extracted` (exempt). A
   * function decides per call; it returns `null` for a call whose argument is not content for people to read (an
   * option picked in a drop-down, a check box ticked): that call's `place()` puts the value in unmarked and reports
   * nothing, and a call that does not place it is not recorded as unmarked.
   */
  edit: EditKind | ((args: A) => EditKind | null);
}

/**
 * The edit kind a declared output stands for in a call: the declared one, or what its function says; `null` when the
 * function says this call writes nothing for people to read.
 */
export function outputEditKind(output: ToolOutput, args: Record<string, unknown>): EditKind | null {
  return typeof output.edit === "function" ? output.edit(args) : output.edit;
}

/**
 * Lets a tool source choose, per conversation, which of its tools the model is offered: tools that come in only when the
 * model asks for them (`OnRequestTools`). .NET: `IToolScope`.
 */
export interface ToolScope {
  /** Whether the model is offered `tool` in `session` now. */
  offers(tool: AgentTool, session: ChatSession): boolean;
  /**
   * Called before a call of `tool` is approved or run. Returns the text that answers the call instead (the tool was not in
   * scope and is now), or undefined to run it.
   */
  beforeCall(tool: AgentTool, session: ChatSession): string | undefined;
}

/** A tool the agent can run: what it is, what it does, where it runs, and its body. */
export interface AgentTool {
  /** The name the model calls it by: letters, digits, `_` and `-`, up to 64. */
  readonly name: string;
  readonly description?: string;
  /** Its parameters, as JSON Schema (an object). */
  readonly parameters: JsonSchema;
  /** What the integrator says it does; the agent's contract may make it stricter. Without one it always asks. */
  readonly toolClass: ToolClass;
  /** `host` (the host application) or `mcp` (an MCP server). */
  readonly source: string;
  /** The MCP server's label, for an MCP tool. */
  readonly server?: string;
  /** Reaches outside the organisation (recorded and shown; no mode acts on it yet). */
  readonly openWorld?: boolean;
  /** What the MCP server's annotations say: the tool only reads. Absent when the server did not say; the card shows it, no mode acts on it. */
  readonly readOnlyHint?: boolean;
  /** What the MCP server's annotations say: the tool may delete or overwrite. Absent when the server did not say. */
  readonly destructiveHint?: boolean;
  /** What it writes for people to read, if it writes such content (see `ToolOutput`). */
  readonly output?: ToolOutput;
  /**
   * What a call acts on, in the user's words, for the approval card (`button "Send" on mail.example.com`): read
   * when the SDK asks, so the user sees what the call will touch, not only its arguments. Undefined or a failure
   * shows the arguments alone.
   */
  describe?(args: Record<string, unknown>, signal: AbortSignal): string | undefined | Promise<string | undefined>;
  /**
   * Decides per conversation whether the model is offered this tool; undefined: always offered. A tool it does not offer
   * can still be called by name: `ToolScope.beforeCall` answers.
   */
  readonly scope?: ToolScope;
  /** Runs the tool. A string goes to the model as it is; anything else as JSON. */
  invoke(args: Record<string, unknown>, context: ToolCallContext): unknown;
}

/**
 * The host tools `profile`'s contract allows, with the stricter of their own class and the contract's. A tool the contract
 * leaves out is dropped (the gateway refuses it anyway; not offering it keeps the model from trying). Without a contract
 * entry -- or an entry without a risk -- nobody on the server vouched for a tool: it is unclassified and always asks.
 */
export function settleHostTools(tools: readonly AgentTool[], profile: AgentProfile): AgentTool[] {
  const contract = new Map(profile.hostToolContract.map((t) => [t.name, t]));
  const settled: AgentTool[] = [];
  for (const tool of tools) {
    const entry = contract.get(tool.name);
    if (contract.size > 0 && !entry) continue;
    const risk: ToolClass = entry ? parseToolClass(entry.risk) : "unknown";
    const toolClass = risk === "unknown" ? "unknown" : effectiveToolClass(tool.toolClass, risk);
    settled.push(toolClass === tool.toolClass ? tool : withToolClass(tool, toolClass));
  }
  return settled;
}

export interface ToolSpec<A extends Record<string, unknown>> {
  name: string;
  description?: string;
  parameters?: JsonSchema;
  toolClass?: ToolClass;
  openWorld?: boolean;
  /** What it writes for people to read (see `ToolOutput`); a tool that writes such content declares it. */
  output?: ToolOutput<A>;
  /** What a call acts on, for the approval card (see `AgentTool.describe`). */
  describe?(args: A, signal: AbortSignal): string | undefined | Promise<string | undefined>;
  run(args: A, context: ToolCallContext): unknown;
}

const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A host tool: `defineTool({ name: "read_page", toolClass: "read", parameters, run })`. Without a class it is
 * `unknown` and always asks. The arguments are checked against `parameters` before `run`.
 */
export function defineTool<A extends Record<string, unknown> = Record<string, unknown>>(spec: ToolSpec<A>): AgentTool {
  if (!NAME.test(spec.name)) throw new TypeError(`A tool name is letters, digits, _ and -, up to 64: '${spec.name}'.`);
  const parameters = spec.parameters ?? { type: "object", properties: {} };
  const tool: AgentTool = {
    name: spec.name,
    parameters,
    toolClass: spec.toolClass ?? "unknown",
    source: "host",
    invoke: (args, context) => spec.run(args as A, context),
  };
  const describe = spec.describe;
  return {
    ...tool,
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    ...(spec.openWorld !== undefined ? { openWorld: spec.openWorld } : {}),
    ...(spec.output !== undefined ? { output: toolOutput(spec.name, spec.output) } : {}),
    ...(describe ? { describe: (args: Record<string, unknown>, signal: AbortSignal) => describe(args as A, signal) } : {}),
  };
}

/** A declared output, checked and frozen; a function of the arguments gets them as the tool's own type. */
function toolOutput<A>(tool: string, output: ToolOutput<A>): ToolOutput {
  if (!output.argument?.trim()) throw new TypeError(`The output of '${tool}' names no argument.`);
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(output.mediaType ?? "")) throw new TypeError(`The output of '${tool}' has no media type.`);
  const edit = output.edit;
  if (edit === undefined) throw new TypeError(`The output of '${tool}' has no edit kind.`);
  return Object.freeze({
    argument: output.argument,
    mediaType: output.mediaType,
    edit: typeof edit === "function" ? (args: Record<string, unknown>) => edit(args as A) : edit,
  });
}

/** The tool as the model is offered it. */
export function toDefinition(tool: AgentTool): ToolDefinition {
  const definition: ToolDefinition = { name: tool.name, parameters: tool.parameters };
  if (tool.description) definition.description = tool.description;
  return definition;
}

/** A tool with another class or source, the rest the same (e.g. the contract's stricter class). */
export function withToolClass(tool: AgentTool, toolClass: ToolClass): AgentTool {
  return {
    name: tool.name,
    parameters: tool.parameters,
    toolClass,
    source: tool.source,
    ...(tool.description !== undefined ? { description: tool.description } : {}),
    ...(tool.server !== undefined ? { server: tool.server } : {}),
    ...(tool.openWorld !== undefined ? { openWorld: tool.openWorld } : {}),
    ...(tool.readOnlyHint !== undefined ? { readOnlyHint: tool.readOnlyHint } : {}),
    ...(tool.destructiveHint !== undefined ? { destructiveHint: tool.destructiveHint } : {}),
    ...(tool.output !== undefined ? { output: tool.output } : {}),
    ...(tool.scope !== undefined ? { scope: tool.scope } : {}),
    ...(tool.describe ? { describe: (args: Record<string, unknown>, signal: AbortSignal) => tool.describe!(args, signal) } : {}),
    invoke: (args, context) => tool.invoke(args, context),
  };
}

/**
 * What is wrong with `args` for `schema`, or undefined: required properties, and the types and enums of the
 * properties given. Enough to tell a model what to fix; the tool still checks what it relies on.
 */
export function checkArguments(schema: JsonSchema, args: Record<string, unknown>): string | undefined {
  const problems: string[] = [];
  for (const name of schema.required ?? []) {
    if (args[name] === undefined || args[name] === null) problems.push(`'${name}' is required`);
  }
  for (const [name, value] of Object.entries(args)) {
    const property = schema.properties?.[name];
    if (!property) {
      if (schema.additionalProperties === false) problems.push(`'${name}' is not a parameter`);
      continue;
    }
    if (value === null || value === undefined) continue;
    const types = property.type === undefined ? [] : Array.isArray(property.type) ? property.type : [property.type];
    if (types.length && !types.some((t) => isType(value, t))) problems.push(`'${name}' must be ${types.join(" or ")}`);
    if (property.enum && !property.enum.includes(value)) {
      problems.push(`'${name}' must be one of ${property.enum.map((e) => JSON.stringify(e)).join(", ")}`);
    }
  }
  return problems.length ? `Invalid arguments: ${problems.join("; ")}.` : undefined;
}

function isType(value: unknown, type: string): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && !Array.isArray(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}
