/** Explicit host-command input is strict JSON, copied before review and never retargeted after it. */
export function commandJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(commandJson).join(",")}]`;
  if (value && typeof value === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${commandJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  throw new TypeError("Command arguments must contain only JSON values.");
}

export async function commandSchemaHash(schema: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(commandJson(schema));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
