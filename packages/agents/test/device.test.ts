import { describe, expect, it } from "vitest";

import { DEVICE_LIMITS, toWireManifest, type LogEvent } from "@fadenstack/client";
import { buildDevice, describeDeviceOs, mcpProgramProblem, pluginProblem } from "@fadenstack/agents";

import { setup, until } from "./helpers.js";

const SHA = "a".repeat(64);

describe("the operating system the device block names", () => {
  it("is Node's own type, release and architecture, and never longer than 100 characters", () => {
    const os = { type: () => "Windows_NT", release: () => "10.0.26100" };
    const text = describeDeviceOs({ process: { versions: { node: "22.0.0" }, arch: "x64", platform: "win32", getBuiltinModule: () => os } });
    expect(text).toBe("Windows_NT 10.0.26100 x64");
    const long = describeDeviceOs({ process: { versions: { node: "22.0.0" }, arch: "x64", getBuiltinModule: () => ({ type: () => "X".repeat(300), release: () => "1" }) } });
    expect(long).toHaveLength(DEVICE_LIMITS.os);
  });

  it("is Node's platform and architecture where Node cannot name the system", () => {
    expect(describeDeviceOs({ process: { versions: { node: "20.0.0" }, arch: "arm64", platform: "darwin" } })).toBe("darwin arm64");
    expect(describeDeviceOs({ process: { versions: { node: "20.0.0" }, arch: "arm64", platform: "linux", getBuiltinModule: () => { throw new Error("no"); } } })).toBe("linux arm64");
  });

  it("is the browser's platform, never the whole user agent", () => {
    const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
    expect(describeDeviceOs({ navigator: { userAgentData: { platform: "Windows" }, platform: "Win32" } })).toBe("Windows");
    expect(describeDeviceOs({ navigator: { platform: "MacIntel" } })).toBe("MacIntel");
    expect(describeDeviceOs({ navigator: {} })).toBe("Browser");
    expect(describeDeviceOs({})).toBe("Browser");
    expect(describeDeviceOs({ navigator: { platform: "Linux x86_64" } })).not.toContain(userAgent);
  });
});

describe("the device block", () => {
  it("holds the os, the app's version, the declared plugins and no MCP program, cut to the limits", () => {
    const device = buildDevice({
      os: "O".repeat(150), appVersion: "9".repeat(80),
      plugins: [{ name: "contoso-crm", version: "1.0.0", sha256: SHA.toUpperCase() }],
    });
    expect(device.os).toHaveLength(100);
    expect(device.appVersion).toHaveLength(50);
    expect(device.plugins).toEqual([{ name: "contoso-crm", version: "1.0.0", sha256: SHA }]);
    expect(device.mcpPrograms).toEqual([]);
  });

  it("leaves out a plugin that does not fit, says only its kind and why, and keeps the others", () => {
    const told: string[] = [];
    const device = buildDevice({
      os: "x", appVersion: "1",
      plugins: [
        { name: "", version: "1", sha256: SHA },
        { name: "n".repeat(129), version: "1", sha256: SHA },
        { name: "long-version", version: "v".repeat(51), sha256: SHA },
        { name: "short-hash", version: "1", sha256: "abc" },
        { name: "not-hex", version: "1", sha256: "g".repeat(64) },
        { name: "good", version: "", sha256: SHA },
      ],
    }, (kind, reason) => told.push(`${kind}:${reason}`));
    expect(device.plugins?.map((p) => p.name)).toEqual(["good"]);
    expect(told).toEqual(["plugin:name_invalid", "plugin:name_invalid", "plugin:version_too_long", "plugin:sha256_invalid", "plugin:sha256_invalid"]);
  });

  it("takes at most 100 plugins and 100 MCP programs, and an MCP program is a file name with its hash", () => {
    const many = Array.from({ length: 130 }, (_, i) => ({ name: `p${i}`, version: "1", sha256: SHA }));
    const programs = Array.from({ length: 130 }, (_, i) => ({ name: `s${i}`, program: "server.exe", sha256: SHA }));
    const told: string[] = [];
    const device = buildDevice({ os: "x", appVersion: "1", plugins: many, mcpPrograms: programs }, (kind, reason) => told.push(`${kind}:${reason}`));
    expect(device.plugins).toHaveLength(100);
    expect(device.mcpPrograms).toHaveLength(100);
    expect(told.filter((t) => t === "plugin:too_many")).toHaveLength(30);
    expect(mcpProgramProblem({ name: "files", program: "", sha256: SHA })).toBe("program_invalid");
    expect(mcpProgramProblem({ name: "files", program: "x".repeat(256), sha256: SHA })).toBe("program_invalid");
    expect(mcpProgramProblem({ name: "files", program: "server.exe", sha256: SHA })).toBeUndefined();
    expect(pluginProblem({ name: "p", version: "1", sha256: SHA })).toBeUndefined();
  });

  it("goes onto the wire in the server's names, with the lists always present", () => {
    const wire = toWireManifest({
      app: { name: "A", version: "1" }, tools: [],
      device: { os: "Windows", appVersion: "1", plugins: [{ name: "p", version: "2", sha256: SHA }], mcpPrograms: [] },
    });
    expect(wire["device"]).toEqual({ os: "Windows", app_version: "1", plugins: [{ name: "p", version: "2", sha256: SHA }], mcp_programs: [] });
    expect(toWireManifest({ app: { name: "A" }, tools: [] })["device"]).toBeUndefined();
  });
});

describe("what the agent reports about the device", () => {
  it("sends the block with the manifest at start: os, the app's version, the declared plugins and no MCP program", async () => {
    const s = await setup({ model: () => ({ text: "ok" }) }, undefined,
      (b) => b.describeApp({ name: "Viewer add-in", version: "2.1.0" }).describePlugins([{ name: "contoso-crm", version: "1.0.0", sha256: SHA }]));
    await s.agent.start();
    await until(() => s.gateway.manifests.length > 0);
    const device = s.gateway.deviceOf("docs")!;
    expect(device["app_version"]).toBe("2.1.0");
    expect(typeof device["os"]).toBe("string");
    expect((device["os"] as string).length).toBeGreaterThan(0);
    expect(device["plugins"]).toEqual([{ name: "contoso-crm", version: "1.0.0", sha256: SHA }]);
    expect(device["mcp_programs"]).toEqual([]);
  });

  it("never puts a path, a user name or an environment value into it", async () => {
    const s = await setup({ model: () => ({ text: "ok" }) }, undefined, (b) => b.describeApp({ name: "Viewer add-in", version: "2.1.0" }));
    await s.agent.start();
    await until(() => s.gateway.manifests.length > 0);
    const text = JSON.stringify(s.gateway.deviceOf("docs"));
    const g = globalThis as { process?: { env?: Record<string, string | undefined>; cwd?: () => string } };
    for (const secret of [g.process?.env?.["USERNAME"], g.process?.env?.["USER"], g.process?.env?.["HOME"], g.process?.cwd?.()]) {
      if (secret && secret.length > 3) expect(text).not.toContain(secret);
    }
    expect(Object.keys(s.gateway.deviceOf("docs")!).sort()).toEqual(["app_version", "mcp_programs", "os", "plugins"]);
  });

  it("leaves a plugin that does not fit out, logs the kind and the reason only, and the manifest still goes through", async () => {
    const events: LogEvent[] = [];
    const s = await setup({ model: () => ({ text: "ok" }) }, undefined,
      (b) => b.useLogging({ log: (e) => events.push(e) }).describePlugins([
        { name: "secret-plugin-name", version: "1", sha256: "not-a-hash" },
        { name: "good", version: "1", sha256: SHA },
      ]));
    await s.agent.start();
    await until(() => s.gateway.manifests.length > 0);
    expect((s.gateway.deviceOf("docs")!["plugins"] as { name: string }[]).map((p) => p.name)).toEqual(["good"]);
    const dropped = events.filter((e) => e.eventId === 2018);
    expect(dropped.map((e) => e.fields)).toEqual([{ Kind: "plugin", Reason: "sha256_invalid" }]);
    expect(JSON.stringify(events)).not.toContain("secret-plugin-name");
  });

  it("sends no block when event reporting is off, as it sends no manifest", async () => {
    const s = await setup({ model: () => ({ text: "ok" }) }, undefined, (b) => b.useEventReporting(false).describePlugins([{ name: "p", version: "1", sha256: SHA }]));
    await s.agent.start();
    await new Promise((r) => setTimeout(r, 20));
    expect(s.gateway.deviceOf("docs")).toBeUndefined();
  });
});

describe("the fake gateway's device block", () => {
  it("checks the block as core 0.7.1 does: a block that does not fit is a 400 invalid_manifest, and a good one is kept as sent", async () => {
    const s = await setup({ model: () => ({ text: "ok" }) });
    const resource = s.client.agent!;
    const good = { app: { name: "A", version: "1" }, tools: [], device: { os: "Windows 11", appVersion: "1", plugins: [{ name: "p", version: "1", sha256: SHA }], mcpPrograms: [] } };

    await resource.reportManifest(good);
    expect(s.gateway.deviceOf("docs")).toEqual({ os: "Windows 11", app_version: "1", plugins: [{ name: "p", version: "1", sha256: SHA }], mcp_programs: [] });

    // The SDK itself never sends these; a host that bypassed it would be refused, as core refuses it.
    const bad = (device: Record<string, unknown>) => resource.reportManifest({ ...good, device } as never);
    await expect(bad({ os: "o".repeat(101) })).rejects.toMatchObject({ status: 400 });
    await expect(bad({ appVersion: "v".repeat(51) })).rejects.toMatchObject({ status: 400 });
    await expect(bad({ plugins: [{ name: "p", version: "1", sha256: "ABC" }] })).rejects.toMatchObject({ status: 400 });
    await expect(bad({ plugins: Array.from({ length: 101 }, (_, i) => ({ name: `p${i}`, version: "1", sha256: SHA })) })).rejects.toMatchObject({ status: 400 });
    await expect(bad({ mcpPrograms: [{ name: "f", program: "p".repeat(256), sha256: SHA }] })).rejects.toMatchObject({ status: 400 });
    expect(s.gateway.manifests).toHaveLength(1);
  });

  it("leaves a manifest without a block alone, as an older SDK sends it", async () => {
    const s = await setup({ model: () => ({ text: "ok" }) });
    await s.client.agent!.reportManifest({ app: { name: "A" }, tools: [] });
    expect(s.gateway.manifests).toHaveLength(1);
    expect(s.gateway.deviceOf("docs")).toBeUndefined();
  });
});
