import { toAgentProfile, type ToolContractEntry } from "@fadenstack/client";

type Json = Record<string, unknown>;

/** The server's rule for a slug (core `SLUG_PATTERN`): lower case, digits and inner hyphens, 1 to 64. */
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const isObject = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
const own = (object: Json, key: string): unknown => (Object.hasOwn(object, key) ? object[key] : undefined);
const text = (object: Json | undefined, key: string): string | undefined => {
  const value = object ? own(object, key) : undefined;
  return typeof value === "string" ? value : undefined;
};

/**
 * An agent's definition as an app ships it (its `contracts/*.json`, core's templates): the body the server's
 * `POST /api/agents` takes. In standalone mode it stands in for the server's profile (sdk/51 F03): the slug and name, the
 * instructions, the host tool contract, the local MCP and skills modes and the greeting. `model_alias` is ignored; every
 * other field is kept as it was (`json`), so a definition from a newer app reads and writes back whole.
 *
 * Fail closed: a tool whose `risk` is missing or unknown is unclassified, so it asks every time; a mode other than `allow`
 * is `disable`. Reading never throws on such a value, only on a body that has no valid slug. .NET: `AgentDefinition`.
 */
export class AgentDefinition {
  /** The agent's slug: its data and sessions are kept under it. */
  readonly slug: string;
  /** The agent's name; its slug when the definition gives none. */
  readonly name: string;
  readonly description: string | undefined;
  /** The agent's own instructions (`version.instructions`); empty when it has none. */
  readonly instructions: string;
  /**
   * The host tools the agent may offer, each with its class (`risk`) as written: one that is missing or unknown counts as
   * unclassified (`parseToolClass` reads it as `unknown`), so the tool asks. An entry without a name is left out; a target
   * mapping the SDK cannot read is left out of its entry, as in a server's profile.
   */
  readonly hostToolContract: readonly ToolContractEntry[];
  /** The server's own tools the agent uses (`version.server_tools`); a server's only, so unused in standalone. */
  readonly serverTools: readonly string[] | null;
  /** `allow` or `disable` (anything else, or nothing, is `disable`). */
  readonly localMcpMode: "allow" | "disable";
  /** `allow` or `disable` (anything else, or nothing, is `disable`). */
  readonly localSkillsMode: "allow" | "disable";
  /** The greeting, suggestions, languages and the rest of `version.ui`, as written; null when it has none. */
  readonly ui: Readonly<Record<string, unknown>> | null;
  /** The whole definition as it was read, unknown fields included. */
  readonly json: Readonly<Json>;

  private constructor(json: Json, slug: string) {
    this.json = json;
    this.slug = slug;
    this.name = text(json, "name") ?? slug;
    this.description = text(json, "description");
    const versionValue = own(json, "version");
    const version = isObject(versionValue) ? versionValue : undefined;
    this.instructions = text(version, "instructions") ?? "";
    this.hostToolContract = contractOf(version);
    const servers = version ? own(version, "server_tools") : undefined;
    this.serverTools = Array.isArray(servers) ? servers.filter((x): x is string => typeof x === "string") : null;
    this.localMcpMode = modeOf(version, "local_mcp_mode");
    this.localSkillsMode = modeOf(version, "local_skills_mode");
    const ui = version ? own(version, "ui") : undefined;
    this.ui = isObject(ui) ? Object.fromEntries(Object.entries(ui).map(([key, value]) => [key, structuredClone(value)])) : null;
  }

  /** The definition as JSON text, as it was read (unknown fields included). */
  toJson(): string {
    return JSON.stringify(this.json);
  }

  /**
   * Reads a definition from JSON text or from an object (kept as a copy). Throws a `TypeError` when it is not a JSON object
   * with a valid slug.
   */
  static fromJson(json: string | object): AgentDefinition {
    let value: unknown = json;
    if (typeof json === "string") {
      try {
        value = JSON.parse(json);
      } catch (error) {
        throw new TypeError("The agent definition is not valid JSON.", { cause: error });
      }
    }
    if (!isObject(value)) throw new TypeError("The agent definition must be a JSON object.");
    const slug = text(value, "slug");
    if (slug === undefined || !SLUG_PATTERN.test(slug)) {
      throw new TypeError("The agent definition needs a slug: lower-case letters, digits and inner hyphens, at most 64 characters.");
    }
    return new AgentDefinition(structuredClone(value), slug);
  }
}

function contractOf(version: Json | undefined): ToolContractEntry[] {
  const contract = version ? own(version, "host_tool_contract") : undefined;
  if (!Array.isArray(contract)) return [];
  // An entry without a name names no tool. The rest is read as a server's profile reads it (risk kept as written: anything
  // `parseToolClass` does not know is `unknown`, so the tool asks).
  const named = contract.filter((item): item is Json => isObject(item) && (text(item, "name") ?? "").length > 0);
  return toAgentProfile({ host_tool_contract: named }).hostToolContract;
}

function modeOf(version: Json | undefined, key: string): "allow" | "disable" {
  return text(version, key)?.trim().toLowerCase() === "allow" ? "allow" : "disable";
}
