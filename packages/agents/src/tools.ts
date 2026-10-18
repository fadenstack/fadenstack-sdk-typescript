import type { EditKind, JsonSchema, ToolClass, ToolDefinition } from "@fadenstack/client";

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
  /** `generated`, `rewritten`, `summarised` (marked); `translated`, `corrected`, `formatted`, `extracted` (exempt). */
  edit: EditKind | ((args: A) => EditKind);
}

/** The edit kind a declared output stands for in a call: the declared one, or what its function says. */
export function outputEditKind(output: ToolOutput, args: Record<string, unknown>): EditKind {
  return typeof output.edit === "function" ? output.edit(args) : output.edit;
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
  /** What it writes for people to read, if it writes such content (see `ToolOutput`). */
  readonly output?: ToolOutput;
  /**
   * What a call acts on, in the user's words, for the approval card (`button "Send" on mail.example.com`): read
   * when the SDK asks, so the user sees what the call will touch, not only its arguments. Undefined or a failure
   * shows the arguments alone.
   */
  describe?(args: Record<string, unknown>, signal: AbortSignal): string | undefined | Promise<string | undefined>;
  /** Runs the tool. A string goes to the model as it is; anything else as JSON. */
  invoke(args: Record<string, unknown>, context: ToolCallContext): unknown;
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
    ...(tool.output !== undefined ? { output: tool.output } : {}),
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
