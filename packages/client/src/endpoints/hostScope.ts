/** Where an address points, for the plain-http rule (D3): this device, a private network, or anywhere else. */
export type AddressScope = "loopback" | "private" | "public";

/**
 * The scope of a host, for the plain-http rule (D3; OWASP ASVS 5.0 V12). **This differs from .NET's
 * `NetworkAddress.OfHostAsync`, because a browser cannot resolve names:** .NET resolves a name and takes the widest scope of
 * every address it answers with, then checks the address actually connected to; here only the host's own spelling decides.
 *
 * - An IPv4 or IPv6 literal is sorted by its range exactly like .NET: loopback 127/8 and ::1; private 10/8, 172.16/12,
 *   192.168/16, 169.254/16, fe80::/10 and fc00::/7; everything else public, 100.64/10 (CGNAT) included. An IPv4-mapped IPv6
 *   address (`::ffff:a.b.c.d`) counts as the IPv4 address.
 * - `localhost` and `*.localhost` (RFC 6761) are loopback.
 * - Any other name counts as private only when it is a single label (`nas`) or ends in `.local`, `.lan`, `.home.arpa` or
 *   `.internal`; every other name is public, so plain http to it is refused.
 *
 * A name that merely looks local can still point anywhere: that is the price of not resolving, and why https stays the
 * way for anything beyond this device.
 */
export function hostScope(host: string): AddressScope {
  let name = host.trim().toLowerCase();
  if (name.startsWith("[") && name.endsWith("]")) name = name.slice(1, -1);
  if (name.endsWith(".")) name = name.slice(0, -1);
  const v4 = parseIPv4(name);
  if (v4) return scopeOfV4(v4);
  const v6 = name.includes(":") ? parseIPv6(name) : undefined;
  if (v6) return scopeOfV6(v6);
  if (name.includes(":")) return "public"; // not an address we can read
  if (name === "localhost" || name.endsWith(".localhost")) return "loopback";
  if (!name.includes(".")) return name === "" ? "public" : "private";
  return [".local", ".lan", ".home.arpa", ".internal"].some((suffix) => name.endsWith(suffix)) ? "private" : "public";
}

function parseIPv4(text: string): number[] | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const n = Number(part);
    if (n > 255) return undefined;
    bytes.push(n);
  }
  return bytes;
}

function scopeOfV4(b: number[]): AddressScope {
  const [a = 0, c = 0] = b;
  if (a === 127) return "loopback";
  return a === 10 || (a === 172 && c >= 16 && c <= 31) || (a === 192 && c === 168) || (a === 169 && c === 254) ? "private" : "public";
}

/** Eight 16-bit groups, or undefined when the text is not an IPv6 address. */
function parseIPv6(text: string): number[] | undefined {
  let rest = text;
  const zone = rest.indexOf("%");
  if (zone >= 0) rest = rest.slice(0, zone);
  const tail: number[] = [];
  const lastColon = rest.lastIndexOf(":");
  const dotted = parseIPv4(rest.slice(lastColon + 1));
  if (dotted) {
    tail.push(dotted[0]! * 256 + dotted[1]!, dotted[2]! * 256 + dotted[3]!);
    rest = rest.slice(0, lastColon + 1) + "0:0"; // a placeholder for the two groups, replaced below
  }
  const halves = rest.split("::");
  if (halves.length > 2) return undefined;
  const group = (s: string): number[] | undefined => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return undefined;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = group(halves[0]!);
  const back = halves.length === 2 ? group(halves[1]!) : [];
  if (!head || !back) return undefined;
  let groups: number[];
  if (halves.length === 2) {
    const fill = 8 - head.length - back.length;
    if (fill < 1) return undefined;
    groups = [...head, ...new Array<number>(fill).fill(0), ...back];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return undefined;
  if (dotted) groups = [...groups.slice(0, 6), ...tail];
  return groups;
}

function scopeOfV6(g: number[]): AddressScope {
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return scopeOfV4([g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255]); // IPv4-mapped
  }
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return "loopback";
  if ((g[0]! & 0xffc0) === 0xfe80 || (g[0]! & 0xfe00) === 0xfc00) return "private";
  return "public";
}
