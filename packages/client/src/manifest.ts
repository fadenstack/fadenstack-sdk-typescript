import type { JsonSchema } from "./chat/types.js";
import type { EditKind } from "./provenance/contract.js";
import type { ToolClass } from "./tools/toolModes.js";

/** This SDK, as manifests name it. */
export const SDK_LANGUAGE = "typescript";
export const SDK_VERSION = "0.3.0";

/** A host tool as the app's developer describes it: its class is a suggestion the server's admins review. */
export interface ManifestTool {
  name: string;
  description?: string;
  parameters?: JsonSchema;
  toolClass?: ToolClass;
  openWorld?: boolean;
  /**
   * What it writes for people to read: the argument, its media type and the edit kind (left out when the tool
   * decides it per call). A write tool without one is one the server's admins may ask about. Sent as a list of one:
   * `"outputs": [{ "argument", "media_type", "edit_kind"? }]`.
   */
  output?: { argument: string; mediaType: string; editKind?: EditKind };
}

/** Something the app offers the agent to read, by its id (`page:document`). */
export interface ManifestContext {
  id: string;
  title?: string;
  kind?: string;
}

/** A plugin of the app, as the app declares it: its name, version and the SHA-256 of its file (64 lowercase hex). .NET: `ManifestPlugin`. */
export interface ManifestPlugin {
  name: string;
  version: string;
  sha256: string;
}

/**
 * A local MCP server's program: the server's label, the program's file name (never its folder) and its SHA-256. The browser
 * starts no local program, so this SDK never sends one; the type is the wire format's, as the .NET SDK sends it. .NET: `ManifestMcpProgram`.
 */
export interface ManifestMcpProgram {
  name: string;
  program: string;
  sha256: string;
}

/**
 * What the app reports about the device it runs on (`device` of `PUT /v1/agents/{agent}/manifest`): a short description of
 * the operating system, the app's version, its plugins and the MCP programs it runs. Never a path, a user name, an argument
 * or an environment value. The limits are the server's (see {@link DEVICE_LIMITS}). .NET: `ManifestDevice`.
 */
export interface ManifestDevice {
  os?: string;
  appVersion?: string;
  plugins?: ManifestPlugin[];
  mcpPrograms?: ManifestMcpProgram[];
}

/** The server's limits for the device block (core 0.7.1): the SDK cuts to them before it sends. */
export const DEVICE_LIMITS = Object.freeze({
  os: 100, appVersion: 50, entries: 100, name: 128, version: 50, program: 255,
});

/** A SHA-256 as the server takes it: 64 lowercase hex characters. */
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * What an app brings to the agent it runs (`PUT /v1/agents/{agent}/manifest`): its host tools, its context and
 * its default greeting. The server keeps it for review; nothing in it changes what the agent may do.
 */
export interface AppManifest {
  app: { name: string; version?: string };
  sdk?: { language: string; version: string };
  tools: ManifestTool[];
  context?: ManifestContext[];
  ui?: { greeting?: string; suggestions?: string[] };
  /** What the app reports about the device (see {@link ManifestDevice}). */
  device?: ManifestDevice;
}

/** The manifest as the gateway reads it (snake_case, `class`). */
export function toWireManifest(manifest: AppManifest): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    app: { name: manifest.app.name, version: manifest.app.version ?? "" },
    tools: manifest.tools.map((tool) => {
      const out: Record<string, unknown> = { name: tool.name, class: tool.toolClass ?? "unknown" };
      if (tool.description !== undefined) out["description"] = tool.description;
      if (tool.parameters !== undefined) out["parameters"] = tool.parameters;
      if (tool.openWorld !== undefined) out["open_world"] = tool.openWorld;
      // On the wire a list, as the .NET SDK sends it (a tool may write several arguments): `outputs`.
      if (tool.output !== undefined) {
        out["outputs"] = [{
          argument: tool.output.argument,
          media_type: tool.output.mediaType,
          ...(tool.output.editKind !== undefined ? { edit_kind: tool.output.editKind } : {}),
        }];
      }
      return out;
    }),
    context: manifest.context ?? [],
  };
  if (manifest.sdk) wire["sdk"] = manifest.sdk;
  if (manifest.ui) wire["ui"] = manifest.ui;
  if (manifest.device) {
    const device = manifest.device;
    wire["device"] = {
      os: device.os ?? "",
      app_version: device.appVersion ?? "",
      plugins: (device.plugins ?? []).map((p) => ({ name: p.name, version: p.version, sha256: p.sha256 })),
      mcp_programs: (device.mcpPrograms ?? []).map((p) => ({ name: p.name, program: p.program, sha256: p.sha256 })),
    };
  }
  return wire;
}
