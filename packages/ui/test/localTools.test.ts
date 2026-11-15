import { describe, expect, it } from "vitest";

import {
  CloudToolsStatus,
  ImportNote,
  ImportProblem,
  ImportSkipReason,
  LocalPlainHttpRefusal,
  LocalServerState,
  LocalToolClass,
  LocalToolRaise,
  ServerProblem,
  TestOutcome,
  ToolsPolicy,
} from "@fadenstack/agents";

import {
  ImportSheetViewModel,
  PLAIN_HTTP_WARNING_VERSION,
  ServerSheetViewModel,
  ServerStatusKind,
  ToolsPageViewModel,
  builtInStrings,
  englishStrings,
  germanStrings,
  type UiStrings,
} from "../src/index.js";
import { FakeCatalog, SECRET, cloudTool, refused, serverInfo, tool } from "./toolsFakes.js";

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const LAN = { where: "http://192.168.1.5:8931/mcp", plainHttpApplies: true };

function page(catalog = new FakeCatalog([serverInfo("files")]), strings: () => UiStrings = () => englishStrings): ToolsPageViewModel {
  return new ToolsPageViewModel({ catalog, strings });
}

async function opened(catalog: FakeCatalog, label = "files"): Promise<{ vm: ToolsPageViewModel; details: NonNullable<ToolsPageViewModel["details"]> }> {
  const vm = page(catalog);
  await vm.open();
  vm.servers.find((s) => s.label === label)!.open();
  return { vm, details: vm.details! };
}

describe("the page", () => {
  it("says to sign in while nobody is, and lists nothing", async () => {
    const catalog = new FakeCatalog([serverInfo("files")]);
    catalog.signedIn = false;
    catalog.policy = ToolsPolicy.Unknown;
    const vm = page(catalog);
    await vm.open();
    expect(vm.needsSignIn).toBe(true);
    expect(vm.showsLists).toBe(false);
    expect(vm.hasPolicy).toBe(false);
    expect(vm.showsBanner).toBe(false);
    expect(catalog.cloudCalls).toBe(0);
  });

  it.each([
    [ToolsPolicy.Allowed, "Allowed", false, false],
    [ToolsPolicy.DeveloperMode, "Developer mode", true, false],
    [ToolsPolicy.NotAllowed, "Not allowed for this assistant", true, true],
  ])("shows the policy %s as a chip, and a banner only where it is not allowed", (policy, text, warning, banner) => {
    const catalog = new FakeCatalog();
    catalog.policy = policy;
    const vm = page(catalog);
    expect(vm).toMatchObject({ policyText: text, policyIsWarning: warning, showsBanner: banner, hasPolicy: true, showsLocalChip: true });
    expect(vm.bannerText).toBe("This assistant may not use MCP servers on this computer.");
  });

  it("counts the tools on the tabs, switches tabs, and shows Add on the computer's tab only", async () => {
    const catalog = new FakeCatalog([serverInfo("a", { tools: [tool("x"), tool("y")] }), serverInfo("b")]);
    catalog.cloud = { status: CloudToolsStatus.Listed, tools: [cloudTool("find", "crm"), cloudTool("save", "crm")] };
    const vm = page(catalog);
    await vm.open();
    expect(vm.localTabText).toBe("On this computer · 3");
    expect(vm.serverTabText).toBe("On your server · 2");
    expect(vm.showsAddButton).toBe(true);
    vm.selectTab("server");
    expect(vm).toMatchObject({ showsServer: true, showsAddButton: false, showsLocalChip: false });
  });

  it("shows the empty state, the filter's no-match line, and the list note", () => {
    const empty = page(new FakeCatalog());
    expect(empty).toMatchObject({ showsEmpty: true, hasServers: false, showsNoMatch: false });
    const catalog = new FakeCatalog([serverInfo("files"), serverInfo("notes", { tools: [tool("find_note")] })]);
    catalog.serversKeptOnDisk = false;
    const vm = page(catalog);
    expect(vm.listNote).toBe(englishStrings.toolsKeptInMemory);
    vm.filter = "note";
    expect(vm.servers.map((s) => s.label)).toEqual(["notes"]);
    vm.filter = "zzz";
    expect(vm.showsNoMatch).toBe(true);
    vm.filter = "";
    expect(vm.servers).toHaveLength(2);
    catalog.serversUnreadable = true;
    vm.refresh();
    expect(vm.listNote).toBe(englishStrings.toolsListUnreadable);
  });

  it("lists the cloud tools by server, with the summary and each tool's state, narrowed by the filter", async () => {
    const catalog = new FakeCatalog();
    catalog.cloud = { status: CloudToolsStatus.Listed, tools: [
      cloudTool("find", "crm"), cloudTool("hidden", "crm", { enabled: false }), cloudTool("write", "crm", { allowed: false }), cloudTool("ping", "wiki"),
    ] };
    const vm = page(catalog);
    await vm.open();
    const [crm, wiki] = vm.cloudGroups;
    expect(vm.cloudGroups.map((g) => g.server)).toEqual(["crm", "wiki"]);
    expect(crm!.summary).toBe("3 tools · 1 for this assistant · 1 switched off");
    expect(wiki!.summary).toBe("1 tool · 1 for this assistant");
    expect(crm!.tools.map((t) => [t.name, t.stateText, t.isForThis, t.isNotFor, t.isOff])).toEqual([
      ["find", "For this assistant", true, false, false], ["hidden", "Switched off by your administrator", false, false, true], ["write", "Not for this assistant", false, true, false],
    ]);
    vm.filter = "ping";
    expect(vm.cloudGroups.map((g) => g.server)).toEqual(["wiki"]);
    crm!.toggle();
    expect(crm!.isCollapsed).toBe(true);
  });

  it.each([
    [CloudToolsStatus.NotListed, englishStrings.toolsCloudNotListed, false],
    [CloudToolsStatus.Unavailable, englishStrings.toolsCloudUnavailable, true],
    [CloudToolsStatus.Listed, englishStrings.toolsCloudNone, false],
  ])("says %s in words, and offers Try again only when the list could not be loaded", async (status, text, retry) => {
    const catalog = new FakeCatalog();
    catalog.cloud = { status, tools: [] };
    const vm = page(catalog);
    await vm.open();
    expect(vm.cloudMessage).toBe(text);
    expect(vm.canRetry).toBe(retry);
  });

  it("loads the cloud tools again on Try again", async () => {
    const catalog = new FakeCatalog();
    catalog.cloudFails = true;
    const vm = page(catalog);
    await vm.open();
    expect(vm.canRetry).toBe(true);
    catalog.cloudFails = false;
    catalog.cloud = { status: CloudToolsStatus.Listed, tools: [cloudTool("find", "crm")] };
    await vm.retry();
    expect(vm).toMatchObject({ canRetry: false, hasCloudMessage: false });
    expect(vm.cloudGroups).toHaveLength(1);
  });

  it("follows the catalog's changes, keeps the card of a server that stays, and stops after dispose", async () => {
    const catalog = new FakeCatalog([serverInfo("files")]);
    const vm = page(catalog);
    const card = vm.servers[0]!;
    catalog.localServers = [serverInfo("files", { state: LocalServerState.Off, enabled: false }), serverInfo("new")];
    catalog.changed();
    expect(vm.servers[0]).toBe(card);
    expect(card.statusText).toBe("Off · 1 tool");
    expect(vm.servers.map((s) => s.label)).toEqual(["files", "new"]);
    vm.dispose();
    expect(catalog.listenerCount).toBe(0);
  });

  it("closes the top layer with Esc: the warning, the question, the sheet, then the details", async () => {
    const catalog = new FakeCatalog([serverInfo("nas", LAN)]);
    catalog.plainHttpPermitted = true;
    const { vm, details } = await opened(catalog, "nas");
    details.plainHttpOn = true;
    details.askRemove();
    expect(vm.closeTop()).toBe(true);
    expect(details.isPlainHttpWarningOpen).toBe(false);
    expect(details.isConfirmingRemove).toBe(true);
    vm.closeTop();
    expect(details.isConfirmingRemove).toBe(false);
    vm.closeTop();
    expect(vm.isDetailsOpen).toBe(false);
    vm.addServer();
    vm.closeTop();
    expect(vm.hasSheet).toBe(false);
    expect(vm.closeTop()).toBe(false);
  });
});

describe("a server's card", () => {
  const card = (info: Parameters<typeof serverInfo>[1], permitted = true) => {
    const catalog = new FakeCatalog([serverInfo("s", info)]);
    catalog.plainHttpPermitted = permitted;
    return page(catalog).servers[0]!;
  };

  it("says Running with the tool count, the origin line and up to three chips with +n", () => {
    const c = card({ tools: [tool("a"), tool("b", { destructive: true }), tool("c"), tool("d"), tool("e")], origin: "mcpServers" });
    expect(c).toMatchObject({ statusText: "Running · 5 tools", statusKind: ServerStatusKind.Good, originText: "From mcpServers · https://s.example.com/mcp", moreText: "+2", hasMore: true });
    expect(c.chips.map((x) => [x.name, x.mayDelete, x.isMore])).toEqual([["a", false, false], ["b", true, false], ["c", false, false], ["+2", false, true]]);
    expect(c.chips[1]!.tip).toBe("b, may delete");
    expect(c.switchName).toBe("Switch s on or off");
    expect(c.openName).toBe("Show details of s");
  });

  it.each([
    [{ state: LocalServerState.Off, enabled: false, tools: [] }, "Off", ServerStatusKind.Neutral],
    [{ state: LocalServerState.Starting }, "Starting", ServerStatusKind.Neutral],
    [{ state: LocalServerState.Failed, detail: "it did not answer" }, "Can’t start: it did not answer", ServerStatusKind.Problem],
    [{ state: LocalServerState.Failed }, "Can’t start: no reason given", ServerStatusKind.Problem],
    [{ state: LocalServerState.NotAllowed }, "Not allowed", ServerStatusKind.Warning],
    [{ toolsChanged: true }, "Changed its tools", ServerStatusKind.Warning],
  ])("says %j as %s", (info, text, kind) => {
    const c = card(info);
    expect(c.statusText).toBe(text);
    expect(c.statusKind).toBe(kind);
  });

  it("offers the fix for a header with no value, and opens the edit sheet from it", async () => {
    const catalog = new FakeCatalog([serverInfo("api", { state: LocalServerState.Failed, secretNames: ["Authorization"], missingValues: ["Authorization"] })]);
    const vm = page(catalog);
    const c = vm.servers[0]!;
    expect(c).toMatchObject({ statusText: "Can’t start: Authorization has no value", fixText: "Add the value", hasFix: true });
    c.fix();
    await flush();
    expect(vm.sheet).toBeInstanceOf(ServerSheetViewModel);
    expect((vm.sheet as ServerSheetViewModel).title).toBe("Edit api");
  });

  it.each([
    [LocalPlainHttpRefusal.NoOptIn, englishStrings.mcpPlainHttpNoOptIn],
    [LocalPlainHttpRefusal.NotLocal, englishStrings.mcpPlainHttpNotLocal],
    [LocalPlainHttpRefusal.Secret, englishStrings.mcpPlainHttpSecret],
    [LocalPlainHttpRefusal.NotAllowed, "Plain http is not allowed here."],
  ])("says the refusal %s in its own words, and offers no fix", (refusal, text) => {
    const catalog = new FakeCatalog([refused("nas", refusal)]);
    const c = page(catalog).servers[0]!;
    expect(c).toMatchObject({ statusText: text, statusKind: ServerStatusKind.Warning, plainHttpRefusal: refusal, hasFix: false });
  });

  it("says 'not allowed here' for a server whose switch is on where plain http is not permitted, until it runs", () => {
    const stuck = card({ ...LAN, plainHttpInLan: true, state: LocalServerState.Starting }, false);
    expect(stuck.statusText).toBe("Plain http is not allowed here.");
    expect(card({ ...LAN, plainHttpInLan: true, state: LocalServerState.Running }, false).statusKind).toBe(ServerStatusKind.Good);
    expect(card({ ...LAN, plainHttpInLan: true, state: LocalServerState.Off, enabled: false }, false).statusText).toMatch(/^Off/);
  });

  it("switches a server from the card, and tells the catalog once", async () => {
    const catalog = new FakeCatalog([serverInfo("files")]);
    const vm = page(catalog);
    vm.servers[0]!.isOn = false;
    await flush();
    expect(catalog.enabledCalls).toEqual([{ label: "files", enabled: false }]);
    expect(vm.servers[0]).toMatchObject({ isOn: false, statusText: "Off · 1 tool" });
  });
});

describe("the details", () => {
  it("shows the facts without a secret, the running time and the tools with their hints and classes", async () => {
    const catalog = new FakeCatalog([serverInfo("api", {
      secretNames: ["Authorization"], callTimeoutSeconds: 120, runningSince: new Date(2026, 10, 15, 17, 3),
      tools: [tool("read", { readOnly: true, class: LocalToolClass.Read }), tool("wipe", { destructive: true, class: LocalToolClass.Destructive }), tool("idem", { idempotent: true, openWorld: true })],
    })]);
    const { details } = await opened(catalog, "api");
    expect(details.facts.map((f) => [f.label, f.value])).toEqual([
      ["Added", "By you"], ["Address", "https://api.example.com/mcp"], ["Secrets", "Authorization"], ["Longest call", "2 minutes"],
    ]);
    expect(details.statusText).toMatch(/^Running since /);
    expect(details.toolsTitle).toBe("Tools · 3");
    const [read, wipe, idem] = details.tools;
    expect(read).toMatchObject({ classText: "Reads", hints: ["Says: reads only"], canRaise: true, isDestructive: false });
    expect(wipe).toMatchObject({ classText: "Destructive", isDestructive: true, canRaise: false, destructiveHelp: englishStrings.toolsDestructiveHelp });
    expect(wipe!.raiseOptions).toEqual([]);
    expect(idem!.hints).toEqual(["Says: safe to repeat", "Says: reaches outside this computer"]);
    expect(idem!.classText).toBe("Asks every time");
    expect(idem!.raiseName).toBe("Class of idem");
    details.toolFilter = "wipe";
    expect(details.tools.map((t) => t.name)).toEqual(["wipe"]);
    details.toolFilter = "nothing";
    expect(details.noToolsText).toBe("No tool matches.");
  });

  it("trusts a server and raises a tool through the catalog, and shows them as the administrator's when marks are not the person's", async () => {
    const catalog = new FakeCatalog([serverInfo("files", { tools: [tool("echo"), tool("wipe", { destructive: true, class: LocalToolClass.Destructive })] })]);
    const { vm, details } = await opened(catalog);
    details.isTrusted = true;
    details.tools[0]!.selectedRaise = LocalToolRaise.Write;
    details.tools[1]!.selectedRaise = LocalToolRaise.Read; // no picker for a destructive tool: nothing is asked
    await flush();
    expect(catalog.trustedCalls).toEqual([{ label: "files", trusted: true }]);
    expect(catalog.raiseCalls).toEqual([{ label: "files", tool: "echo", raise: LocalToolRaise.Write }]);
    expect(vm.details!.isTrusted).toBe(true);
    expect(vm.details!.tools[0]!.selectedRaise).toBe(LocalToolRaise.Write);

    catalog.marksAreYours = false;
    vm.refresh();
    expect(details.canChangeMarks).toBe(false);
    expect(details.trustedNote).toBe(englishStrings.toolsTrustedByAdmin);
    details.isTrusted = false;
    details.tools[0]!.selectedRaise = LocalToolRaise.None;
    await flush();
    expect(catalog.trustedCalls).toHaveLength(1);
    expect(catalog.raiseCalls).toHaveLength(1);
  });

  it("tests, restarts, and removes only after the question", async () => {
    const catalog = new FakeCatalog([serverInfo("files")]);
    catalog.testResult = { outcome: TestOutcome.Started, tools: ["echo", "write"] };
    const { vm, details } = await opened(catalog);
    await details.test();
    expect(details.testText).toBe("Started. Tools: echo, write");
    expect(catalog.tested[0]!.original).toBe("files");
    await details.restart();
    expect(catalog.restarted).toEqual(["files"]);
    expect(details.testText).toBe("Restarted.");
    details.askRemove();
    expect(details.removeConfirmText).toBe("Remove files?");
    expect(catalog.removed).toEqual([]);
    details.keep();
    details.askRemove();
    await details.confirmRemove();
    expect(catalog.removed).toEqual(["files"]);
    expect(vm.isDetailsOpen).toBe(false);
  });

  it("closes itself when its server is gone", async () => {
    const catalog = new FakeCatalog([serverInfo("files")]);
    const { vm } = await opened(catalog);
    catalog.localServers = [];
    catalog.changed();
    expect(vm.isDetailsOpen).toBe(false);
  });
});

describe("Advanced: the plain-http switch", () => {
  it.each([
    ["plain http beyond this computer, permitted", { ...LAN }, true, true],
    ["permitted, but the address is https or on this computer", {}, true, false],
    ["the address applies, but plain http is not permitted here", { ...LAN }, false, false],
  ])("is shown only when it applies and is permitted (%s)", async (_why, info, permitted, shown) => {
    const catalog = new FakeCatalog([serverInfo("s", info)]);
    catalog.plainHttpPermitted = permitted;
    const { details } = await opened(catalog, "s");
    expect(details.showsAdvanced).toBe(shown);
  });

  async function onLan(on = false) {
    const catalog = new FakeCatalog([serverInfo("nas", { ...LAN, plainHttpInLan: on })]);
    catalog.plainHttpPermitted = true;
    return { catalog, ...(await opened(catalog, "nas")) };
  }

  it("opens the warning and changes nothing until Confirm, which passes the warning's version", async () => {
    const { catalog, details } = await onLan();
    details.plainHttpOn = true;
    expect(details.isPlainHttpWarningOpen).toBe(true);
    expect(details.plainHttpWarningText).toBe(englishStrings.mcpPlainHttpWarning);
    expect(details.plainHttpOn).toBe(false);
    await flush();
    expect(catalog.switchCalls).toEqual([]);

    await details.confirmPlainHttp();
    expect(catalog.switchCalls).toEqual([{ label: "nas", on: true, version: "2026-11-15" }]);
    expect(PLAIN_HTTP_WARNING_VERSION).toBe("2026-11-15");
    expect(details).toMatchObject({ plainHttpOn: true, isPlainHttpWarningOpen: false, plainHttpWarningText: "", hasPlainHttpError: false });
  });

  it("leaves it off on Cancel, and a second Confirm does nothing", async () => {
    const { catalog, details } = await onLan();
    details.plainHttpOn = true;
    details.cancelPlainHttp();
    await details.confirmPlainHttp();
    expect(catalog.switchCalls).toEqual([]);
    expect(details).toMatchObject({ plainHttpOn: false, isPlainHttpWarningOpen: false });
  });

  it("turns off at once with no warning and no version", async () => {
    const { catalog, details } = await onLan(true);
    details.plainHttpOn = false;
    await flush();
    expect(details.isPlainHttpWarningOpen).toBe(false);
    expect(catalog.switchCalls).toEqual([{ label: "nas", on: false, version: undefined }]);
    expect(details.plainHttpOn).toBe(false);
  });

  it("says why the catalog refused the switch, and shows it still off", async () => {
    const { catalog, details } = await onLan();
    catalog.switchProblem = ServerProblem.PlainHttpWithHeaders;
    details.plainHttpOn = true;
    await details.confirmPlainHttp();
    expect(details.plainHttpError).toBe(englishStrings.toolsProblemPlainHttpWithHeaders);
    expect(details.plainHttpOn).toBe(false);
  });

  it("drops an open warning when the switch is no longer offered", async () => {
    const { catalog, vm, details } = await onLan();
    details.plainHttpOn = true;
    catalog.plainHttpPermitted = false;
    vm.refresh();
    expect(details).toMatchObject({ showsAdvanced: false, isPlainHttpWarningOpen: false });
  });
});

describe("the add and edit sheet", () => {
  it("adds a server: checks it, hands the draft over, clears the typed header value and closes", async () => {
    const catalog = new FakeCatalog();
    const vm = page(catalog);
    vm.addServer();
    const sheet = vm.sheet as ServerSheetViewModel;
    expect(sheet).toMatchObject({ title: "Add a server", primaryText: "Add", isAdding: true, timeoutText: "120", enabled: true });
    sheet.label = " notes ";
    sheet.url = "https://mcp.example.com/mcp";
    sheet.addHeader();
    const row = sheet.headerRows[0]!;
    row.name = "Authorization";
    row.value = SECRET;
    await sheet.save();
    expect(catalog.saved).toHaveLength(1);
    expect(catalog.saved[0]!.original).toBeUndefined();
    expect(catalog.saved[0]!.draft).toMatchObject({ label: "notes", url: "https://mcp.example.com/mcp", callTimeoutSeconds: 120, headers: [{ name: "Authorization", value: SECRET, isKept: false }] });
    expect(row.value).toBe("");
    expect(vm.hasSheet).toBe(false);
  });

  it("keeps the problem on the sheet, in words, and the typed value for another try", async () => {
    const catalog = new FakeCatalog();
    catalog.problem = ServerProblem.LabelTaken;
    const vm = page(catalog);
    vm.addServer();
    const sheet = vm.sheet as ServerSheetViewModel;
    sheet.addHeader();
    sheet.headerRows[0]!.name = "X";
    sheet.headerRows[0]!.value = SECRET;
    await sheet.save();
    expect(sheet.errorText).toBe(englishStrings.toolsProblemLabelTaken);
    expect(catalog.saved).toEqual([]); // the catalog's own check came first
    expect(sheet.headerRows[0]!.value).toBe(SECRET);
    sheet.cancel();
    expect(sheet.headerRows[0]!.value).toBe("");
  });

  it.each([
    [ServerProblem.LabelMissing, "toolsProblemLabelMissing"],
    [ServerProblem.LabelInvalid, "toolsProblemLabelInvalid"],
    [ServerProblem.NameInvalid, "toolsProblemName"],
    [ServerProblem.ValueInvalid, "toolsProblemValue"],
    [ServerProblem.AddressMissing, "toolsProblemAddressMissing"],
    [ServerProblem.AddressInvalid, "toolsProblemAddressInvalid"],
    [ServerProblem.TimeoutOutOfRange, "toolsProblemTimeout"],
    [ServerProblem.TooManyHeaders, "toolsProblemTooManyHeaders"],
    [ServerProblem.PlainHttpWithHeaders, "toolsProblemPlainHttpWithHeaders"],
    [ServerProblem.PlainHttpNotLocal, "toolsProblemPlainHttpNotLocal"],
  ] as const)("says %s in its own words", async (problem, key) => {
    const catalog = new FakeCatalog();
    catalog.problem = problem;
    const vm = page(catalog);
    vm.addServer();
    const sheet = vm.sheet as ServerSheetViewModel;
    await sheet.save();
    expect(sheet.errorText).toBe(englishStrings[key]);
    expect(sheet.errorText).not.toBe("");
  });

  it("refuses a timeout that is not a number without asking the catalog", async () => {
    const catalog = new FakeCatalog();
    const vm = page(catalog);
    vm.addServer();
    const sheet = vm.sheet as ServerSheetViewModel;
    sheet.timeoutText = "soon";
    await sheet.save();
    expect(sheet.errorText).toBe(englishStrings.toolsProblemTimeout);
    expect(catalog.saved).toEqual([]);
  });

  it("opens an edit sheet with header names and 'saved' rows, never a value, and replaces one on request", async () => {
    const catalog = new FakeCatalog([serverInfo("api", { secretNames: ["Authorization", "X-Org"] })]);
    const vm = page(catalog);
    vm.servers[0]!.fix();
    await vm.edit("api");
    const sheet = vm.sheet as ServerSheetViewModel;
    expect(sheet).toMatchObject({ title: "Edit api", primaryText: "Save", isEditing: true });
    expect(sheet.headerRows.map((r) => [r.name, r.isKept, r.showsInput, r.value])).toEqual([["Authorization", true, false, ""], ["X-Org", true, false, ""]]);
    sheet.headerRows[1]!.replace();
    sheet.headerRows[1]!.value = "globex";
    await sheet.save();
    expect(catalog.saved[0]!.original).toBe("api");
    expect(catalog.saved[0]!.draft.headers).toEqual([{ name: "Authorization", value: "", isKept: true }, { name: "X-Org", value: "globex", isKept: false }]);
  });

  it("removes a row and forgets its value, and drops rows with no name from the draft", async () => {
    const catalog = new FakeCatalog();
    const vm = page(catalog);
    vm.addServer();
    const sheet = vm.sheet as ServerSheetViewModel;
    sheet.addHeader();
    sheet.addHeader();
    sheet.headerRows[0]!.name = "A";
    sheet.headerRows[0]!.value = "1";
    sheet.headerRows[1]!.value = "orphan";
    const [first] = sheet.headerRows;
    first!.remove();
    expect(first!.value).toBe("");
    sheet.label = "x";
    sheet.url = "https://x.example.com";
    await sheet.save();
    expect(catalog.saved[0]!.draft.headers).toEqual([]);
  });

  it("tests the draft, says the result in words, and clears nothing the person may still save", async () => {
    const catalog = new FakeCatalog();
    const vm = page(catalog);
    vm.addServer();
    const sheet = vm.sheet as ServerSheetViewModel;
    sheet.addHeader();
    sheet.headerRows[0]!.name = "Authorization";
    sheet.headerRows[0]!.value = SECRET;
    for (const [result, text] of [
      [{ outcome: TestOutcome.Started, tools: ["echo"] }, "Started. Tools: echo"],
      [{ outcome: TestOutcome.Started, tools: [] }, englishStrings.toolsTestOkNoTools],
      [{ outcome: TestOutcome.Failed, tools: [], error: "it did not answer" }, "Could not start: it did not answer"],
      [{ outcome: TestOutcome.NotAllowed, tools: [] }, "Not started: this assistant may not use MCP servers on this computer."],
      [{ outcome: TestOutcome.Failed, tools: [], plainHttp: LocalPlainHttpRefusal.NoOptIn }, englishStrings.mcpPlainHttpNoOptIn],
    ] as const) {
      catalog.testResult = result;
      await sheet.test();
      expect(sheet.testText).toBe(text);
    }
    expect(catalog.tested[0]!.draft.headers[0]!.value).toBe(SECRET);
    expect(sheet.headerRows[0]!.value).toBe(SECRET);
    sheet.dispose();
    expect(sheet.headerRows[0]!.value).toBe("");
  });

  it("forgets the typed values when a sheet is replaced by another, and when the page is disposed", () => {
    const vm = page(new FakeCatalog());
    vm.addServer();
    const first = vm.sheet as ServerSheetViewModel;
    first.addHeader();
    first.headerRows[0]!.value = SECRET;
    vm.importServers();
    expect(first.headerRows[0]!.value).toBe("");
    vm.addServer();
    const second = vm.sheet as ServerSheetViewModel;
    second.addHeader();
    second.headerRows[0]!.value = SECRET;
    vm.dispose();
    expect(second.headerRows[0]!.value).toBe("");
  });

  it("never puts a header value in what it tells the person", async () => {
    const catalog = new FakeCatalog();
    catalog.testResult = { outcome: TestOutcome.Failed, tools: [], error: "it refused the sign-in (check the headers)" };
    const vm = page(catalog);
    vm.addServer();
    const sheet = vm.sheet as ServerSheetViewModel;
    sheet.addHeader();
    sheet.headerRows[0]!.name = "Authorization";
    sheet.headerRows[0]!.value = SECRET;
    await sheet.test();
    expect(JSON.stringify([sheet.testText, sheet.errorText, sheet.title])).not.toContain("s3cr3t");
  });
});

describe("the paste-import sheet", () => {
  const pasted = "{\"mcpServers\":{\"remote\":{\"url\":\"https://r.example.com/mcp\",\"headers\":{\"Authorization\":\"Bearer s3cr3t-token\"}}}}";

  function sheetOf(catalog: FakeCatalog): { vm: ToolsPageViewModel; sheet: ImportSheetViewModel } {
    const vm = page(catalog);
    vm.addServer();
    (vm.sheet as ServerSheetViewModel).importMore();
    return { vm, sheet: vm.sheet as ImportSheetViewModel };
  }

  it("reads the text, lists what can be imported and why the others cannot, and forgets the text", async () => {
    const catalog = new FakeCatalog();
    catalog.preview = {
      problem: ImportProblem.None,
      servers: [{ label: "remote", where: "https://r.example.com/mcp", notes: [ImportNote.HeadersLeftOut], detail: "X-Key" }],
      skipped: [
        { name: "prog", reason: ImportSkipReason.Program }, { name: "old", reason: ImportSkipReason.Sse }, { name: "nas", reason: ImportSkipReason.NetworkServer },
        { name: "none", reason: ImportSkipReason.NothingToStart }, { name: "dup", reason: ImportSkipReason.LabelTaken },
        { name: "bad", reason: ImportSkipReason.NotValid, problem: ServerProblem.AddressInvalid }, { name: "odd", reason: ImportSkipReason.NotUnderstood },
      ],
    };
    const { sheet } = sheetOf(catalog);
    expect(sheet.canRead).toBe(false);
    sheet.text = pasted;
    await sheet.read();
    expect(catalog.readTexts).toEqual([pasted]);
    expect(sheet.text).toBe("");
    expect(sheet.statusText).toBe("Servers found: 1");
    expect(sheet.candidates[0]).toMatchObject({ label: "remote", notes: ["Left out: X-Key"], tickName: "Import remote" });
    expect(sheet.skipped.map((s) => s.reason)).toEqual([
      englishStrings.toolsSkipProgram, englishStrings.toolsSkipSse, englishStrings.toolsSkipNetwork, englishStrings.toolsSkipNothing,
      `It breaks a rule: ${englishStrings.toolsProblemLabelTaken}`, `It breaks a rule: ${englishStrings.toolsProblemAddressInvalid}`, englishStrings.toolsSkipNotUnderstood,
    ]);
  });

  it("imports only the ticked ones and says how many were added", async () => {
    const catalog = new FakeCatalog();
    catalog.preview = { problem: ImportProblem.None, servers: [
      { label: "a", where: "https://a.example.com", notes: [] }, { label: "b", where: "https://b.example.com", notes: [] },
    ], skipped: [] };
    const { sheet } = sheetOf(catalog);
    sheet.text = pasted;
    await sheet.read();
    expect(sheet.canImport).toBe(false);
    sheet.candidates[1]!.isTicked = true;
    expect(sheet.canImport).toBe(true);
    await sheet.importSelected();
    expect(catalog.imported).toEqual([{ labels: ["b"] }]);
    expect(sheet.resultText).toBe("Added: 1");
  });

  it.each([
    [ImportProblem.NotJson, englishStrings.toolsPasteProblemNotJson],
    [ImportProblem.NoServerList, englishStrings.toolsPasteProblemNoList],
    [ImportProblem.TooLarge, englishStrings.toolsPasteProblemTooLarge],
    [ImportProblem.Empty, englishStrings.toolsPasteProblemEmpty],
  ])("says a text that is %s in words and keeps it for a correction", async (problem, text) => {
    const catalog = new FakeCatalog();
    catalog.preview = { problem, servers: [], skipped: [] };
    const { sheet } = sheetOf(catalog);
    sheet.text = "not what it should be";
    await sheet.read();
    expect(sheet.statusText).toBe(text);
    expect(sheet.statusIsProblem).toBe(true);
    expect(sheet.text).toBe("not what it should be");
  });

  it("says when nothing can be imported, and forgets the text on dispose", async () => {
    const { sheet } = sheetOf(new FakeCatalog());
    sheet.text = pasted;
    await sheet.read();
    expect(sheet.resultText).toBe(englishStrings.toolsImportNothingToAdd);
    sheet.text = pasted;
    sheet.dispose();
    expect(sheet.text).toBe("");
  });
});

describe("the texts", () => {
  const keys = (s: UiStrings) => Object.keys(s).filter((k) => k.startsWith("tools") || k.startsWith("mcpPlainHttp"));

  it("has every Tools text in all five languages, none empty, with the same placeholders", () => {
    const english = keys(englishStrings);
    expect(english.length).toBeGreaterThan(150);
    for (const [tag, s] of Object.entries(builtInStrings)) {
      expect(keys(s).sort(), tag).toEqual(english.slice().sort());
      for (const key of english) {
        const value = (s as unknown as Record<string, unknown>)[key];
        const sample = typeof value === "function" ? (value as (...a: unknown[]) => string)("A", "B") : value;
        expect(typeof sample === "string" && sample.length > 0, `${tag}.${key}`).toBe(true);
      }
    }
  });

  it("says the plain-http warning and each refusal in every language, each refusal differently", () => {
    for (const [tag, s] of Object.entries(builtInStrings)) {
      const refusals = [s.mcpPlainHttpNoOptIn, s.mcpPlainHttpNotLocal, s.mcpPlainHttpSecret, s.mcpPlainHttpNotAllowed];
      expect(new Set(refusals).size, tag).toBe(4);
      expect(s.mcpPlainHttpWarning.length, tag).toBeGreaterThan(60);
    }
    expect(germanStrings.mcpPlainHttpWarning).toContain("Klartext-http");
  });

  it("says the owner's neutral wording where no organisation decides", () => {
    expect(englishStrings.toolsPolicyAllowed).toBe("Allowed");
    expect(englishStrings.toolsReasonPolicy).toBe("this assistant may not use MCP servers on this computer");
    expect(germanStrings.toolsPolicyAllowed).toBe("Erlaubt");
    expect(englishStrings.toolsCloudOffByAdmin).toBe("Switched off by your administrator");
  });

  it("says the page again in the new language on retext", () => {
    let current: UiStrings = englishStrings;
    const vm = page(new FakeCatalog([serverInfo("files")]), () => current);
    expect(vm.servers[0]!.statusText).toBe("Running · 1 tool");
    current = germanStrings;
    vm.retext();
    expect(vm.servers[0]!.statusText).toBe(`${germanStrings.toolsStateRunning} · ${germanStrings.toolsCountOne}`);
    expect(vm.policyText).toBe("Erlaubt");
  });
});

describe("the tab In this app and the server tab only when governed", () => {
  const appTool = (name: string, toolClass: "read" | "write" | "destructive", description = `${name} does it`) => ({ name, description, toolClass });

  it("lists the app's own tools with a class label and a plain, cut description, and the filter narrows them by name", () => {
    const catalog = new FakeCatalog();
    catalog.appTools = [appTool("read_page", "read", "Reads <b>the</b>\n page"), appTool("fill_field", "write", "x".repeat(400)), appTool("drop_row", "destructive")];
    const vm = page(catalog);
    expect(vm.tab).toBe("computer"); // the default stays
    expect(vm.appTabText).toBe("In this app · 3");
    expect(vm.appTools.map((t) => [t.name, t.classLabel])).toEqual([
      ["read_page", englishStrings.approvalClass.read], ["fill_field", englishStrings.approvalClass.write], ["drop_row", englishStrings.approvalClass.destructive],
    ]);
    expect(vm.appTools[0]!.description).toBe("Reads <b>the</b> page"); // text, never markup: the skins print it as text
    expect(Array.from(vm.appTools[1]!.description)).toHaveLength(300);
    vm.filter = "FILL";
    expect(vm.appTools.map((t) => t.name)).toEqual(["fill_field"]);
    vm.filter = "zzz";
    expect(vm).toMatchObject({ showsAppNoMatch: true, showsAppEmpty: false });
    expect(vm.appNoMatchText).toBe(englishStrings.toolsNoToolsMatch);
  });

  it("says one short line when the app gives no tools", () => {
    const vm = page(new FakeCatalog());
    expect(vm).toMatchObject({ showsAppEmpty: true, appTabText: "In this app · 0", appEmptyText: "This app gives the assistant no tools of its own." });
    vm.selectTab("app");
    expect(vm).toMatchObject({ showsApp: true, showsAddButton: false, showsLocalChip: false });
  });

  it("has no server tab in standalone, never loads the cloud tools, and refuses to select it", async () => {
    const catalog = new FakeCatalog([serverInfo("files")]);
    catalog.governed = false;
    const vm = page(catalog);
    await vm.open();
    await vm.loadCloud();
    expect(vm.showsServerTab).toBe(false);
    expect(vm.tabs).toEqual(["app", "computer"]);
    expect(catalog.cloudCalls).toBe(0);
    vm.selectTab("server");
    expect(vm.tab).toBe("computer");
  });

  it("has the server tab when governed, in the order app, computer, server, and loads the cloud tools", async () => {
    const catalog = new FakeCatalog([serverInfo("files")]);
    const vm = page(catalog);
    await vm.open();
    expect(vm.showsServerTab).toBe(true);
    expect(vm.tabs).toEqual(["app", "computer", "server"]);
    expect(catalog.cloudCalls).toBeGreaterThan(0);
  });

  it("selects the computer's tab when the server tab was selected and the connection is no longer governed", async () => {
    const catalog = new FakeCatalog([serverInfo("files")]);
    const vm = page(catalog);
    await vm.open();
    vm.selectTab("server");
    expect(vm.showsServer).toBe(true);
    catalog.governed = false;
    catalog.changed();
    expect(vm).toMatchObject({ tab: "computer", showsLocal: true, showsServerTab: false });
  });

  it("says the new texts again in the new language on retext", () => {
    let current: UiStrings = englishStrings;
    const catalog = new FakeCatalog();
    catalog.appTools = [appTool("read_page", "read")];
    const vm = page(catalog, () => current);
    expect(vm.appTabText).toBe("In this app · 1");
    current = germanStrings;
    vm.retext();
    expect(vm.appTabText).toBe(germanStrings.toolsTabApp(1));
    expect(vm.appTools[0]!.classLabel).toBe(germanStrings.approvalClass.read);
    expect(vm.appEmptyText).toBe(germanStrings.toolsAppNone);
    expect(germanStrings.toolsAppNone).not.toBe(englishStrings.toolsAppNone);
  });
});
