import { readFileSync, readdirSync } from "node:fs";

/** The contract's JSON Schemas, as this package keeps a copy of them. */
export const CONTRACT_DIR = new URL("../contracts/provenance/v1/", import.meta.url);

export interface Schema {
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: Schema;
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  anyOf?: Schema[];
  $ref?: string;
  $defs?: Record<string, Schema>;
  [keyword: string]: unknown;
}

/** One schema of the copy, by its file name without `.schema.json` (`signed-record`). */
export function contractSchema(name: string): Schema {
  return JSON.parse(readFileSync(new URL(`${name}.schema.json`, CONTRACT_DIR), "utf8")) as Schema;
}

export function contractSchemaNames(): string[] {
  return readdirSync(CONTRACT_DIR).filter((f) => f.endsWith(".schema.json")).map((f) => f.replace(".schema.json", "")).sort();
}

/**
 * What is wrong with `value` for `schema`: the keywords the contract uses (type, properties, required,
 * additionalProperties, items, enum, const, pattern, anyOf, local $ref). Formats and defaults are not checked.
 */
export function validate(schema: Schema, value: unknown, root: Schema = schema, path = "$"): string[] {
  if (schema.$ref) {
    const name = schema.$ref.replace("#/$defs/", "");
    const target = root.$defs?.[name];
    return target ? validate(target, value, root, path) : [`${path}: unknown $ref ${schema.$ref}`];
  }
  if (schema.anyOf) {
    const fits = schema.anyOf.some((option) => validate(option, value, root, path).length === 0);
    return fits ? [] : [`${path}: fits none of anyOf`];
  }
  const problems: string[] = [];
  if (schema.const !== undefined && value !== schema.const) problems.push(`${path}: is not ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) problems.push(`${path}: ${JSON.stringify(value)} is not one of the enum`);
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length && !types.some((t) => isType(value, t))) return [...problems, `${path}: is not ${types.join(" or ")}`];
  if (typeof value === "string" && schema.pattern && !new RegExp(schema.pattern).test(value)) {
    problems.push(`${path}: does not match ${schema.pattern}`);
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, i) => problems.push(...validate(schema.items!, item, root, `${path}[${i}]`)));
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in object)) problems.push(`${path}: '${key}' is required`);
    for (const [key, item] of Object.entries(object)) {
      const property = schema.properties?.[key];
      if (property) problems.push(...validate(property, item, root, `${path}.${key}`));
      else if (schema.additionalProperties === false) problems.push(`${path}: '${key}' is not allowed`);
    }
  }
  return problems;
}

function isType(value: unknown, type: string): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number";
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    case "null": return value === null;
    default: return true;
  }
}
