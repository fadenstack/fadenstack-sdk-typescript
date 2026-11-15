import {
  CloudToolsStatus,
  ImportNote,
  ImportProblem,
  ImportSkipReason,
  LocalPlainHttpRefusal,
  LocalServerState,
  LocalToolClass,
  ServerProblem,
  ToolsPolicy,
} from "@fadenstack/agents";
import { ImportSheetViewModel, ServerSheetViewModel, ToolsPageViewModel, type UiStrings } from "@fadenstack/ui";

import { FakeCatalog, SECRET, cloudTool, refused, serverInfo, tool } from "../../ui/test/toolsFakes.js";

// Real Tools view models on a catalog in memory, in a given language, driven to a state before a skin draws it. Shared by the React and
// the Vue tests and the render tool: nothing here knows a framework. (The catalog is the view models' own fake: packages/ui/test/toolsFakes.ts.)

export const TOOLS_STATES = [
  "signedOut", "empty", "list", "noMatch", "notAllowed", "developer", "cloud", "cloudNone", "cloudUnavailable", "details", "detailsAdvanced",
  "warning", "detailsAdmin", "confirmRemove", "addSheet", "addError", "editSheet", "pasteEmpty", "pasteRead", "pasteProblem",
] as const;
export type ToolsState = (typeof TOOLS_STATES)[number];

const LAN = { where: "http://192.168.1.5:8931/mcp", plainHttpApplies: true };

function servers() {
  return [
    serverInfo("notes", {
      origin: "typed", where: "https://notes.example.com/mcp", secretNames: ["Authorization"],
      tools: [tool("search_notes", { readOnly: true }), tool("write_note"), tool("delete_note", { destructive: true, class: LocalToolClass.Destructive }), tool("export"), tool("tags")],
    }),
    serverInfo("calendar", { origin: "mcpServers", where: "https://calendar.example.com/mcp", enabled: false, state: LocalServerState.Off, tools: [tool("list_events")] }),
    serverInfo("crm", { where: "https://crm.example.com/mcp", state: LocalServerState.Failed, secretNames: ["X-Api-Key"], missingValues: ["X-Api-Key"], tools: [] }),
    serverInfo("wiki", { where: "https://wiki.example.com/mcp", state: LocalServerState.Failed, detail: "The MCP server 'wiki' could not be attached: it did not answer in time.", tools: [] }),
    refused("nas", LocalPlainHttpRefusal.NoOptIn),
    { ...refused("printer", LocalPlainHttpRefusal.NotAllowed), where: "http://192.168.1.9/mcp" },
  ];
}

export class ToolsHarness {
  readonly catalog: FakeCatalog;
  readonly page: ToolsPageViewModel;
  readonly strings: UiStrings;

  constructor(strings: UiStrings, catalog = new FakeCatalog()) {
    this.strings = strings;
    this.catalog = catalog;
    this.page = new ToolsPageViewModel({ catalog, strings: () => this.strings });
  }

  dispose(): void {
    this.page.dispose();
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export async function reachTools(state: ToolsState, strings: UiStrings): Promise<{ h: ToolsHarness; tools: ToolsPageViewModel; catalog: FakeCatalog }> {
  const catalog = new FakeCatalog(["empty", "signedOut", "addSheet", "addError", "pasteEmpty", "pasteRead", "pasteProblem", "cloud", "cloudNone", "cloudUnavailable"].includes(state) ? [] : servers());
  catalog.plainHttpPermitted = false;
  switch (state) {
    case "signedOut": catalog.signedIn = false; catalog.policy = ToolsPolicy.Unknown; break;
    case "notAllowed": catalog.policy = ToolsPolicy.NotAllowed; break;
    case "developer": catalog.policy = ToolsPolicy.DeveloperMode; catalog.serversKeptOnDisk = false; break;
    case "cloud":
      catalog.cloud = { status: CloudToolsStatus.Listed, tools: [
        cloudTool("find_customer", "crm"), cloudTool("update_customer", "crm", { allowed: false }), cloudTool("export_all", "crm", { enabled: false }), cloudTool("search_pages", "wiki"),
      ] };
      break;
    case "cloudNone": catalog.cloud = { status: CloudToolsStatus.Listed, tools: [] }; break;
    case "cloudUnavailable": catalog.cloud = { status: CloudToolsStatus.Unavailable, tools: [] }; break;
    case "detailsAdvanced": case "warning":
      catalog.localServers = [serverInfo("nas", { ...LAN, state: LocalServerState.NotAllowed, tools: [], plainHttpRefusal: LocalPlainHttpRefusal.NoOptIn })];
      catalog.plainHttpPermitted = true;
      break;
    case "detailsAdmin": catalog.marksAreYours = false; break;
    default: break;
  }
  const h = new ToolsHarness(strings, catalog);
  const page = h.page;
  await page.open();
  const open = (label: string) => page.servers.find((x) => x.label === label)!.open();
  switch (state) {
    case "noMatch": page.filter = "zzz"; break;
    case "cloud": case "cloudNone": case "cloudUnavailable": page.selectTab(false); break;
    case "details": case "detailsAdmin": case "confirmRemove": open("notes"); break;
    case "detailsAdvanced": open("nas"); break;
    case "warning": open("nas"); page.details!.plainHttpOn = true; break;
    case "addSheet": page.addServer(); break;
    case "addError": {
      page.addServer();
      const sheet = page.sheet as ServerSheetViewModel;
      sheet.label = "notes";
      sheet.url = "http://192.168.1.5/mcp";
      sheet.addHeader();
      sheet.headerRows[0]!.name = "Authorization";
      sheet.headerRows[0]!.value = SECRET;
      catalog.problem = ServerProblem.PlainHttpWithHeaders;
      await sheet.save();
      break;
    }
    case "editSheet": {
      await page.edit("notes");
      const sheet = page.sheet as ServerSheetViewModel;
      sheet.addHeader();
      sheet.headerRows[1]!.name = "X-Org";
      sheet.headerRows[1]!.value = "acme";
      break;
    }
    case "pasteEmpty": page.importServers(); break;
    case "pasteRead": case "pasteProblem": {
      if (state === "pasteRead") {
        catalog.preview = {
          problem: ImportProblem.None,
          servers: [
            { label: "remote", where: "https://remote.example.com/mcp", notes: [ImportNote.HeadersLeftOut], detail: "X-Key" },
            { label: "files", where: "https://files.example.com/mcp", notes: [] },
          ],
          skipped: [{ name: "local-db", reason: ImportSkipReason.Program }, { name: "nas", reason: ImportSkipReason.NetworkServer }],
        };
      } else {
        catalog.preview = { problem: ImportProblem.NotJson, servers: [], skipped: [] };
      }
      page.importServers();
      const sheet = page.sheet as ImportSheetViewModel;
      sheet.text = state === "pasteRead" ? "{ \"mcpServers\": {} }" : "not json";
      await sheet.read();
      if (state === "pasteRead") sheet.candidates[1]!.isTicked = true;
      break;
    }
    default: break;
  }
  await flush();
  return { h, tools: page, catalog };
}
