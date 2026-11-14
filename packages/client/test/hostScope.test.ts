import { describe, expect, it } from "vitest";

import { hostScope, type AddressScope } from "@fadenstack/client";

// The plain-http rule's host sorting (D3). Literals are sorted like .NET's NetworkAddress; names by how they are written
// (a browser cannot resolve them), which is the TypeScript-only part.
describe("hostScope", () => {
  it.each<[string, AddressScope]>([
    ["127.0.0.1", "loopback"], ["127.9.9.9", "loopback"], ["[::1]", "loopback"], ["::1", "loopback"], ["[::ffff:127.0.0.1]", "loopback"],
    ["[::ffff:7f00:1]", "loopback"],
    ["10.1.2.3", "private"], ["172.16.0.1", "private"], ["172.31.255.255", "private"], ["192.168.0.1", "private"], ["169.254.1.1", "private"],
    ["[fe80::1]", "private"], ["[febf::1]", "private"], ["[fc00::1]", "private"], ["[fd12:3456::7]", "private"], ["[::ffff:192.168.1.5]", "private"],
    ["172.15.0.1", "public"], ["172.32.0.1", "public"], ["100.64.0.1", "public"], ["8.8.8.8", "public"], ["[fec0::1]", "public"],
    ["[2001:db8::1]", "public"], ["[::ffff:8.8.8.8]", "public"],
    ["localhost", "loopback"], ["LOCALHOST", "loopback"], ["app.localhost", "loopback"], ["localhost.", "loopback"],
    ["nas", "private"], ["nas.local", "private"], ["gpu.lan", "private"], ["gpu.home.arpa", "private"], ["gpu.corp.internal", "private"],
    ["example.com", "public"], ["api.openai.com", "public"], ["local.example.com", "public"], ["lan", "private"], ["", "public"],
  ])("%s is %s", (host, scope) => {
    expect(hostScope(host)).toBe(scope);
  });
});
