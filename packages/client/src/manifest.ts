import type { JsonSchema } from "./chat/types.js";
import type { EditKind } from "./provenance/contract.js";
import type { ToolClass } from "./tools/toolModes.js";

/** This SDK, as manifests name it. */
export const SDK_LANGUAGE = "typescript";
export const SDK_VERSION = "0.2.0-rc.3";

/** A host tool as the app's developer describes it: its class is a suggestion the server's admins review. */
export interface ManifestTool {
  name: string;
  description?: string;
  parameters?: JsonSchema;
  toolClass?: ToolClass;
  openWorld?: boolean;
  /**
   * What it writes for people to read: the argument, its media type and the edit kind (left out when the tool
   * decides it per call). A write tool without one is one the server's admins may ask about.
   */
  output?: { argument: string; mediaType: string; editKind?: EditKind };
}

/** Something the app offers the agent to read, by its id (`page:document`). */
export interface ManifestContext {
  id: string;
  title?: string;
  kind?: string;
}

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
      if (tool.output !== undefined) {
        out["output"] = {
          argument: tool.output.argument,
          media_type: tool.output.mediaType,
          ...(tool.output.editKind !== undefined ? { edit_kind: tool.output.editKind } : {}),
        };
      }
      return out;
    }),
    context: manifest.context ?? [],
  };
  if (manifest.sdk) wire["sdk"] = manifest.sdk;
  if (manifest.ui) wire["ui"] = manifest.ui;
  return wire;
}
