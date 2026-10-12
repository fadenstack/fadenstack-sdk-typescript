import type { JsonSchema, ToolClass, ToolDefinition } from "@fadenstack/client";

/** What a running tool knows about its call. */
export interface ToolCallContext {
  /** Aborted when the turn is stopped. */
  signal: AbortSignal;
  callId: string;
  sessionId: string;
  turnId: string;
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
  /** Runs the tool. A string goes to the model as it is; anything else as JSON. */
  invoke(args: Record<string, unknown>, context: ToolCallContext): unknown;
}

export interface ToolSpec<A extends Record<string, unknown>> {
  name: string;
  description?: string;
  parameters?: JsonSchema;
  toolClass?: ToolClass;
  openWorld?: boolean;
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
  return {
    ...tool,
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    ...(spec.openWorld !== undefined ? { openWorld: spec.openWorld } : {}),
  };
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
