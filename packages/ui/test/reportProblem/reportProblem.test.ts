import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { FadenstackApiError, FadenstackStreamError, FadenstackUnreachableError } from "@fadenstack/client";
import {
  DEFAULT_SUPPORT_EMAIL,
  MAILTO_MAX_LENGTH,
  buildReport,
  chineseSimplifiedStrings,
  describeSystem,
  encodeComponent,
  englishStrings,
  errorForReport,
  frenchStrings,
  germanStrings,
  isSupportEmail,
  recentLogLines,
  reportLabels,
  reportTime,
  spanishStrings,
  supportAddress,
  type ReportFacts,
  type ReportLabels,
  type UiStrings,
} from "@fadenstack/ui";

// The table is shared with the .NET SDK (tests/Fadenstack.UI.Tests/ReportProblem/cases.json): both build these mails byte for byte.
interface Table {
  labels: Record<"en" | "de", Record<string, string>>;
  cases: { name: string; language: "en" | "de"; address: string | null; facts: ReportFacts; log?: string[];
    expected: { subject: string; body: string; mailBody: string; dropped: number; mailto: string | null; copy: string } }[];
}
const table = JSON.parse(readFileSync(new URL("./cases.json", import.meta.url), "utf8")) as Table;

const labelsOf = (language: "en" | "de"): ReportLabels => {
  const t = table.labels[language]!;
  return { ...(t as unknown as ReportLabels), subject: (app) => t["subject"]!.replace("{0}", app), subjectNoApp: (v) => t["subjectNoApp"]!.replace("{0}", v) };
};

describe("the shared table of mails", () => {
  it.each(table.cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const mail = buildReport({ address: c.address ?? undefined, labels: labelsOf(c.language), facts: c.facts, log: c.log });
    expect(mail.subject).toBe(c.expected.subject);
    expect(mail.body).toBe(c.expected.body);
    expect(mail.mailBody).toBe(c.expected.mailBody);
    expect(mail.dropped).toBe(c.expected.dropped);
    expect(mail.mailto ?? null).toBe(c.expected.mailto);
    expect(mail.copy).toBe(c.expected.copy);
  });

  it("has English and German cases", () => {
    expect(new Set(table.cases.map((c) => c.language))).toEqual(new Set(["en", "de"]));
  });

  it("keeps the table's labels equal to the panel's own texts, so the .NET resources can be compared with it", () => {
    for (const [language, strings] of [["en", englishStrings], ["de", germanStrings]] as const) {
      const labels = reportLabels(strings);
      const t = table.labels[language];
      expect({ ...labels, subject: labels.subject("{0}"), subjectNoApp: labels.subjectNoApp("{0}") }).toEqual(t);
    }
  });

  it("builds the subject from the app's name and version, then the SDK; without an app, the SDK's own", () => {
    const [full, , , noApp] = table.cases;
    expect(full!.expected.subject).toBe("Problem with Word add-in 1.2.0 (Fadenstack SDK 0.3.1)");
    expect(noApp!.expected.subject).toBe("Problem with Fadenstack SDK 0.3.1");
  });

  it("encodes everything outside the unreserved characters as UTF-8 percent escapes, CRLF as %0D%0A and a space as %20", () => {
    const mail = buildReport({ address: "support@fadenstack.com", labels: labelsOf("en"), facts: table.cases[0]!.facts });
    expect(mail.mailto!.startsWith("mailto:support@fadenstack.com?subject=Problem%20with%20Word%20add-in%201.2.0%20%28Fadenstack%20SDK%200.3.1%29&body=What%20happened%3A%0D%0A%0D%0A%0D%0A--%20%0D%0AApp%3A%20")).toBe(true);
    expect(mail.mailto).not.toMatch(/[^A-Za-z0-9\-._~%:@?&=+]/); // nothing outside the unreserved set, the escapes and the link's own marks
    expect(mail.body).toContain("\r\n");
    expect(mail.body.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/); // every line break is CRLF
    expect(mail.copy).not.toContain("\r"); // the copy has LF
    expect(encodeComponent("a b~c_d.e-f")).toBe("a%20b~c_d.e-f");
    expect(encodeComponent("!'()*")).toBe("%21%27%28%29%2A");
    expect(encodeComponent("ü日\u{1F600}")).toBe("%C3%BC%E6%97%A5%F0%9F%98%80");
    expect(encodeComponent("\ud800")).toBe("%EF%BF%BD"); // a lone surrogate is U+FFFD
  });

  it("keeps the link within 2 000 characters and drops the body's lines from the end, never the subject or the first line", () => {
    const over = table.cases.filter((c) => c.expected.dropped > 0);
    expect(over.length).toBeGreaterThanOrEqual(2);
    for (const c of over) {
      const mail = buildReport({ address: c.address ?? undefined, labels: labelsOf(c.language), facts: c.facts });
      expect(mail.mailto!.length).toBeLessThanOrEqual(MAILTO_MAX_LENGTH);
      expect(mail.mailBody.startsWith("What happened:\r\n\r\n")).toBe(true);
      expect(mail.body.startsWith(mail.mailBody.trimEnd())).toBe(true);
      expect(mail.mailto).toContain(encodeComponent(mail.subject));
    }
    const [firstOver] = over;
    const mail = buildReport({ address: firstOver!.address ?? undefined, labels: labelsOf("en"), facts: firstOver!.facts });
    expect(mail.mailBody).not.toContain("Error:"); // the error goes first, then the time
    expect(mail.mailBody).not.toContain("Time:");
    expect(mail.mailBody).not.toContain("Server:");
    expect(mail.mailBody).toContain("Mode: Organisation");
    expect(mail.copy).toContain("Error: picture_type_not_allowed (req-8f3a21)"); // the copy keeps every line
  });

  it("leaves the whole mail within the limit at exactly 2 000 characters", () => {
    const facts: ReportFacts = { sdkVersion: "0.3.1", sdk: "Fadenstack SDK 0.3.1 (TypeScript)", time: "2026-11-19 10:42 UTC", agent: "a" };
    const baseLength = buildReport({ address: "support@fadenstack.com", labels: labelsOf("en"), facts }).mailto!.length;
    const filler = MAILTO_MAX_LENGTH - baseLength; // each "a" is one character
    const exact = buildReport({ address: "support@fadenstack.com", labels: labelsOf("en"), facts: { ...facts, agent: "a".repeat(1 + filler) } });
    expect(exact.mailto!.length).toBe(MAILTO_MAX_LENGTH);
    expect(exact.dropped).toBe(0);
    const one = buildReport({ address: "support@fadenstack.com", labels: labelsOf("en"), facts: { ...facts, agent: "a".repeat(2 + filler) } });
    expect(one.dropped).toBe(1); // one character over: the last line, the time, goes
    expect(one.mailBody).not.toContain("Time:");
    expect(one.mailBody).toContain("Agent: aaa");
    expect(one.mailto!.length).toBeLessThanOrEqual(MAILTO_MAX_LENGTH);
  });

  it("leaves a line out when its value is unknown or blank, and the separator when no line is left", () => {
    const facts: ReportFacts = { sdkVersion: "0.3.1", sdk: "Fadenstack SDK 0.3.1 (TypeScript)", time: "2026-11-19 10:42 UTC", app: "  ", system: "", agent: undefined };
    const body = buildReport({ address: "support@fadenstack.com", labels: labelsOf("en"), facts }).body;
    expect(body).toBe("What happened:\r\n\r\n\r\n-- \r\nSDK: Fadenstack SDK 0.3.1 (TypeScript)\r\nTime: 2026-11-19 10:42 UTC");
    expect(buildReport({ address: "support@fadenstack.com", labels: labelsOf("en"), facts }).subject).toBe("Problem with Fadenstack SDK 0.3.1");
  });

  it("puts the browser log's entries after the body in the copy only, and nothing when there are none", () => {
    const withLog = table.cases.find((c) => c.log)!;
    const mail = buildReport({ address: withLog.address ?? undefined, labels: labelsOf(withLog.language), facts: withLog.facts, log: withLog.log });
    expect(mail.copy.endsWith(`-- \nRecent log:\n${withLog.log!.join("\n")}`)).toBe(true);
    expect(mail.mailto).not.toContain("Fadenstack.Agents");
    expect(mail.body).not.toContain("Fadenstack.Agents");
    expect(buildReport({ address: undefined, labels: labelsOf("en"), facts: withLog.facts, log: [] }).copy).not.toContain("Recent log");
  });

  it("refuses an address that is not one plain address, so it never reaches a link", () => {
    const facts = table.cases[0]!.facts;
    for (const address of ["a@b.example?bcc=x@y.example", "a@b.example,c@d.example", "a b@c.example", "a@b.example\n", "100%@b.example", "x".repeat(250) + "@b.example"]) {
      expect(() => buildReport({ address, labels: labelsOf("en"), facts }), address).toThrow(TypeError);
    }
  });
});

describe("the address rules", () => {
  it.each(["a@b.example", "a.b+c@sub.example.org", "first_last-1@mail-host.example", "A@B.EXAMPLE", "support@fadenstack.com"])("accepts %j", (value) => {
    expect(isSupportEmail(value)).toBe(true);
  });

  it.each([
    "a@b.example?bcc=x@y.example", "a@b.example?subject=x", "a@b.example&body=x", "a@b.example,c@d.example", "a b@c.example", " a@b.example",
    "a@b.example ", "a@b.example\n", "a@b.example\r\nBcc: x@y.example", "a\n@b.example", "100%@b.example", "a%40b@c.example", "a@b", "a@.example",
    "a@b..example", "@b.example", "a@b.example;c@d.example", "<a@b.example>", "Name <a@b.example>", "a@b_c.example", "a@b.example#x", "ü@b.example",
    "", "mailto:a@b.example",
  ])("refuses %j", (value) => {
    expect(isSupportEmail(value)).toBe(false);
  });

  it("refuses 255 characters and accepts 254", () => {
    const at = (length: number) => `${"a".repeat(length - "@b.example".length)}@b.example`;
    expect(isSupportEmail(at(254))).toBe(true);
    expect(isSupportEmail(at(255))).toBe(false);
  });

  it.each([undefined, null, 42, {}, ["a@b.example"]])("refuses what is not text: %j", (value) => {
    expect(isSupportEmail(value)).toBe(false);
  });
});

describe("to whom a report goes", () => {
  it("takes the policy's address first, in both modes", () => {
    expect(supportAddress(true, "it@corp.example", "host@app.example")).toBe("it@corp.example");
    expect(supportAddress(false, "it@corp.example", "host@app.example")).toBe("it@corp.example");
  });

  it("goes to the host's own address, then to ours, in standalone mode", () => {
    expect(supportAddress(false, undefined, "host@app.example")).toBe("host@app.example");
    expect(supportAddress(false, undefined, undefined)).toBe(DEFAULT_SUPPORT_EMAIL);
    expect(DEFAULT_SUPPORT_EMAIL).toBe("support@fadenstack.com");
  });

  it("goes nowhere in governed mode without the policy's key: never the host's, never ours", () => {
    expect(supportAddress(true, undefined, "host@app.example")).toBeUndefined();
    expect(supportAddress(true, undefined, undefined)).toBeUndefined();
  });

  it("counts a policy value that is no plain address as absent", () => {
    expect(supportAddress(true, "a@b.example?bcc=x@y.example", undefined)).toBeUndefined();
    expect(supportAddress(false, "a@b.example,c@d.example", "host@app.example")).toBe("host@app.example");
  });
});

describe("the system line", () => {
  it("names the browser and its major version and the OS from userAgentData", () => {
    expect(describeSystem({ userAgentData: { brands: [{ brand: "Not A(Brand", version: "8" }, { brand: "Chromium", version: "131" }, { brand: "Google Chrome", version: "131" }], platform: "Windows" } }))
      .toBe("Chrome 131, Windows");
    expect(describeSystem({ userAgentData: { brands: [{ brand: "Microsoft Edge", version: "130" }, { brand: "Chromium", version: "130" }], platform: "macOS" } })).toBe("Edge 130, macOS");
    expect(describeSystem({ userAgentData: { brands: [{ brand: "Chromium", version: "129" }, { brand: "Not;A=Brand", version: "24" }], platform: "Linux" } })).toBe("Chromium 129, Linux");
  });

  it.each([
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", "Chrome 131, Windows"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.2849.80", "Edge 130, Windows"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 OPR/100.0.0.0", "Opera 100, Windows"],
    ["Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0", "Firefox 133, Linux"],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15", "Safari 18, macOS"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1", "Chrome 131, iOS"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36", "Chrome 131, Android"],
    ["Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36", "Chrome 131, ChromeOS"],
  ])("parses a user agent: %s", (userAgent, expected) => {
    expect(describeSystem({ userAgent })).toBe(expected);
  });

  it("never carries the full user-agent string, or its build numbers", () => {
    const userAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.86 Safari/537.36";
    const system = describeSystem({ userAgent })!;
    expect(system).not.toContain("Mozilla");
    expect(system).not.toContain("6778");
    expect(system).not.toContain("537");
  });

  it("is Node's major version and platform in Node, and nothing where nothing is known", () => {
    expect(describeSystem({ node: { version: "24.1.0", platform: "win32" } })).toBe("Node 24, win32");
    expect(describeSystem({})).toBeUndefined();
    expect(describeSystem({ userAgent: "curl/8.0" })).toBeUndefined();
  });

  it("reads the running environment (Node here) without a full user agent", () => {
    expect(describeSystem()).toMatch(/^Node \d+, \w+$/);
  });
});

describe("a failed turn's error", () => {
  it("names the code of an API error and the server's code of a stream error", () => {
    expect(errorForReport(new FadenstackApiError(400, "no", { code: "picture_type_not_allowed" }))).toEqual({ code: "picture_type_not_allowed", requestId: undefined });
    expect(errorForReport(new FadenstackStreamError("broke", "upstream_closed"))?.code).toBe("upstream_closed");
  });

  it("names an API error without a code by its status, another SDK error by its class, and a plain error by nothing", () => {
    expect(errorForReport(new FadenstackApiError(502, "bad gateway"))?.code).toBe("http_502");
    expect(errorForReport(new FadenstackUnreachableError("down"))?.code).toBe("FadenstackUnreachableError");
    expect(errorForReport(new Error("boom"))).toBeUndefined();
    expect(errorForReport("text")).toBeUndefined();
  });

  it("finds the code in the cause chain and takes a request id only where the error carries one", () => {
    const inner = Object.assign(new FadenstackApiError(403, "off", { code: "agent_disabled" }), { requestId: "req-7" });
    expect(errorForReport(new Error("wrapped", { cause: inner }))).toEqual({ code: "agent_disabled", requestId: "req-7" });
  });

  it("takes only plain tokens: a server's text is never written into a mail unchecked", () => {
    expect(errorForReport(new FadenstackApiError(400, "x", { code: "bad code\nBcc: x@y.example" }))?.code).toBe("http_400");
    expect(errorForReport(Object.assign(new FadenstackApiError(400, "x", { code: "ok" }), { requestId: "a b" }))?.requestId).toBeUndefined();
    expect(errorForReport(new FadenstackApiError(400, "x", { code: "c".repeat(65) }))?.code).toBe("http_400");
  });
});

describe("the time and the log lines", () => {
  const entry = (eventId: number, message: string, fields: Record<string, unknown>) =>
    ({ at: "2026-11-19T10:00:00.000Z", level: "information", category: "Fadenstack.Agents", eventId, message, fields });

  it("masks the names of tools, MCP servers, tool sources and skills, and leaves the event and outcome", () => {
    const lines = recentLogLines([
      entry(2020, "Tool crm_lookup (read, host) ended ok in 2 ms, approval none", { Tool: "crm_lookup", ToolClass: "read", Source: "host", Outcome: "ok" }),
      entry(3000, "MCP server Payroll DB (stdio) attached with 4 tools on 2025-06-18", { Label: "Payroll DB", Transport: "stdio", ToolCount: 4 }),
      entry(3003, "MCP server Payroll DB brought a tool whose name MCP server files already brings", { Label: "Payroll DB", Winner: "files" }),
      entry(3102, "Skill contract-check was skipped: too large", { Skill: "contract-check", Reason: "too large" }),
      entry(2000, "Agent page loaded: version 1", { Agent: "page" }),
    ]);
    expect(lines).toEqual([
      "2026-11-19T10:00:00.000Z information Fadenstack.Agents 2020 Tool [tool] (read, [name]) ended ok in 2 ms, approval none",
      "2026-11-19T10:00:00.000Z information Fadenstack.Agents 3000 MCP server [server] (stdio) attached with 4 tools on 2025-06-18",
      "2026-11-19T10:00:00.000Z information Fadenstack.Agents 3003 MCP server [server] brought a tool whose name MCP server [name] already brings",
      "2026-11-19T10:00:00.000Z information Fadenstack.Agents 3102 Skill [skill] was skipped: too large",
      "2026-11-19T10:00:00.000Z information Fadenstack.Agents 2000 Agent page loaded: version 1",
    ]);
    expect(lines.join("\n")).not.toMatch(/crm_lookup|Payroll|contract-check/);
  });

  it("masks whole words only, and an entry without fields as it is", () => {
    expect(recentLogLines([entry(1, "Tool ab ended; table abc", { Tool: "ab" })])[0]).toContain("Tool [tool] ended; table abc");
    const bare = { at: "t", level: "information", category: "c", eventId: 1, message: "Tool x" };
    expect(recentLogLines([bare])).toEqual(["t information c 1 Tool x"]);
  });

  it("says the time in UTC to the minute", () => {
    expect(reportTime(new Date("2026-11-19T10:42:59.999Z"))).toBe("2026-11-19 10:42 UTC");
  });

  it("keeps the last 50 entries, oldest first, one per line", () => {
    const entries = Array.from({ length: 60 }, (_, i) => ({ at: `2026-11-19T10:00:${String(i).padStart(2, "0")}.000Z`, level: "information", category: "Fadenstack.Agents", eventId: 2000 + i, message: `m${i}` }));
    const lines = recentLogLines(entries);
    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe("2026-11-19T10:00:10.000Z information Fadenstack.Agents 2010 m10");
    expect(lines[49]).toBe("2026-11-19T10:00:59.000Z information Fadenstack.Agents 2059 m59");
  });
});

describe("the five languages", () => {
  const languages: [string, UiStrings][] = [["en", englishStrings], ["de", germanStrings], ["fr", frenchStrings], ["es", spanishStrings], ["zh-Hans", chineseSimplifiedStrings]];
  const textKeys = ["reportProblem", "reportAskIt", "reportContains", "reportNoChats", "reportWriteMail", "reportWhatHappened", "reportApp", "reportSdk", "reportSystem",
    "reportMode", "reportAgent", "reportServer", "reportEndpoint", "reportTime", "reportError", "reportTo", "reportSubjectLabel", "reportRecentLog", "reportModeGoverned",
    "reportModeOwnAi", "reportPlaceThisComputer", "reportPlaceLocalNetwork", "reportPlaceInternet"] as const;

  it.each(languages)("%s has every new text, and the subject and the receiver carry their value", (_tag, strings) => {
    for (const key of textKeys) expect(typeof strings[key] === "string" && strings[key].trim().length > 0, `${strings.language}: ${key}`).toBe(true);
    expect(strings.reportGoesTo("who@b.example")).toContain("who@b.example");
    expect(strings.reportSubject("Word add-in 1.2.0")).toContain("Word add-in 1.2.0");
    expect(strings.reportSubjectNoApp("0.3.1")).toContain("Fadenstack SDK 0.3.1");
    expect(strings.reportModeGoverned).not.toBe(strings.reportModeOwnAi);
  });

  it("speaks German, which is binding, with the existing words", () => {
    expect(germanStrings.reportProblem).toBe("Problem melden");
    expect(germanStrings.copyDetails).toBe("Details kopieren");
    expect(germanStrings.reportSubject("Word-Add-in 1.2.0")).toBe("Problem mit Word-Add-in 1.2.0");
  });
});
