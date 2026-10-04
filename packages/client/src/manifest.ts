import type { JsonSchema } from "./chat/types.js";
import type { ToolClass } from "./tools/toolModes.js";

/** This SDK, as manifests name it. */
export const SDK_LANGUAGE = "typescript";
export const SDK_VERSION = "0.1.0";

/** A host tool as the app's developer describes it: its class is a suggestion the server's admins review. */
export interface ManifestTool {
  name: string;
  description?: string;
  parameters?: JsonSchema;
  toolClass?: ToolClass;
  openWorld?: boolean;
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
      return out;
    }),
    context: manifest.context ?? [],
  };
  if (manifest.sdk) wire["sdk"] = manifest.sdk;
  if (manifest.ui) wire["ui"] = manifest.ui;
  return wire;
}
