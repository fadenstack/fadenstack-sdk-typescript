import { DEVICE_LIMITS, SHA256_PATTERN, type ManifestDevice, type ManifestMcpProgram, type ManifestPlugin } from "@fadenstack/client";

/**
 * Where the device's operating system is read from: the browser's `navigator` and Node's `process`. Tests give their own;
 * the default is the runtime's (`globalThis`).
 */
export interface OsSource {
  navigator?: { userAgentData?: { platform?: string }; platform?: string };
  process?: {
    versions?: { node?: string };
    platform?: string;
    arch?: string;
    getBuiltinModule?: (id: string) => unknown;
  };
}

/**
 * A short description of the operating system for the manifest's `device.os`, cut to 100 characters, never the whole user
 * agent. In Node: `os.type()`, `os.release()` and the architecture (`Windows_NT 10.0.26100 x64`); where Node cannot say, its
 * platform and architecture. In a browser: `navigator.userAgentData.platform` where it exists, else `navigator.platform`,
 * else `Browser`. .NET: the runtime's `OSDescription` and architecture.
 */
export function describeDeviceOs(source: OsSource = globalThis as unknown as OsSource): string {
  const proc = source.process;
  if (proc?.versions?.node) {
    const arch = proc.arch ?? "";
    try {
      const os = proc.getBuiltinModule?.("node:os") as { type(): string; release(): string } | undefined;
      if (os) return cut(`${os.type()} ${os.release()} ${arch}`, DEVICE_LIMITS.os);
    } catch {
      // the platform and architecture are the fallback
    }
    return cut(`${proc.platform ?? "node"} ${arch}`, DEVICE_LIMITS.os);
  }
  const nav = source.navigator;
  const platform = nav?.userAgentData?.platform?.trim() || nav?.platform?.trim();
  return cut(platform || "Browser", DEVICE_LIMITS.os);
}

/** Why an entry is left out of the device block (the log says it, with the kind of entry; never the entry). */
export type DeviceDropReason = "name_invalid" | "version_too_long" | "program_invalid" | "sha256_invalid" | "too_many";

/** Whether a plugin the app declared fits the server's limits; the reason when it does not. */
export function pluginProblem(plugin: ManifestPlugin): DeviceDropReason | undefined {
  if (typeof plugin?.name !== "string" || plugin.name.trim().length === 0 || plugin.name.length > DEVICE_LIMITS.name) return "name_invalid";
  if (typeof plugin.version !== "string" || plugin.version.length > DEVICE_LIMITS.version) return "version_too_long";
  if (typeof plugin.sha256 !== "string" || !SHA256_PATTERN.test(plugin.sha256.toLowerCase())) return "sha256_invalid";
  return undefined;
}

/** Whether an MCP program entry fits the server's limits; the reason when it does not. */
export function mcpProgramProblem(entry: ManifestMcpProgram): DeviceDropReason | undefined {
  if (typeof entry?.name !== "string" || entry.name.trim().length === 0 || entry.name.length > DEVICE_LIMITS.name) return "name_invalid";
  if (typeof entry.program !== "string" || entry.program.length === 0 || entry.program.length > DEVICE_LIMITS.program) return "program_invalid";
  if (typeof entry.sha256 !== "string" || !SHA256_PATTERN.test(entry.sha256.toLowerCase())) return "sha256_invalid";
  return undefined;
}

/** What goes into a manifest's `device`: the sources, before the limits. */
export interface DeviceInput {
  os: string;
  appVersion: string | undefined;
  plugins: readonly ManifestPlugin[];
  mcpPrograms?: readonly ManifestMcpProgram[];
}

/**
 * The device block, cut to the server's limits: the operating system and the app's version cut, each plugin and program
 * checked (one that does not fit is left out and `dropped` is told its kind and the reason, never the entry), the SHA-256
 * in lower case, at most 100 of each. Nothing else is ever put in: no path, user name, argument or environment value.
 * .NET: `DeviceReport.Build`.
 */
export function buildDevice(input: DeviceInput, dropped: (kind: "plugin" | "mcp_program", reason: DeviceDropReason) => void = () => undefined): ManifestDevice {
  const plugins: ManifestPlugin[] = [];
  for (const p of input.plugins) {
    const problem = pluginProblem(p);
    if (problem) dropped("plugin", problem);
    else if (plugins.length >= DEVICE_LIMITS.entries) dropped("plugin", "too_many");
    else plugins.push({ name: p.name, version: p.version, sha256: p.sha256.toLowerCase() });
  }
  const mcpPrograms: ManifestMcpProgram[] = [];
  for (const m of input.mcpPrograms ?? []) {
    const problem = mcpProgramProblem(m);
    if (problem) dropped("mcp_program", problem);
    else if (mcpPrograms.length >= DEVICE_LIMITS.entries) dropped("mcp_program", "too_many");
    else mcpPrograms.push({ name: m.name, program: m.program, sha256: m.sha256.toLowerCase() });
  }
  return {
    os: cut(input.os, DEVICE_LIMITS.os),
    appVersion: cut(input.appVersion ?? "", DEVICE_LIMITS.appVersion),
    plugins,
    mcpPrograms,
  };
}

function cut(text: string, max: number): string {
  const clean = text.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return clean.length > max ? clean.slice(0, max) : clean;
}
