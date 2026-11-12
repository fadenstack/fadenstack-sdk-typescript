# Local tools

This page covers tools on request: how an agent keeps a long list of host tools out of the model's way until it asks for them, and why this is the TypeScript SDK's answer to the .NET SDK's [local MCP servers](../dotnet/local-mcp.md).

## No local MCP process in a browser

The .NET SDK can start MCP servers on the device and attach their tools to the agent. A browser page or an extension cannot start a process, so the TypeScript SDK has no local MCP module. A tool in the TypeScript SDK is a host tool: a function of your application, defined with `defineTool` and added to the builder. See [Tools and approvals](tools.md).

What the .NET module also does, and what a long list of tools needs, is keep the tools out of the model's request until the model asks for them. `OnRequestTools` does that over the host's own tools. It is the same seam as the .NET module's `find_tool`: one search tool, and the matching tools switched on for the conversation.

## Add tools on request

```ts
import { FadenstackAgent, OnRequestTools, defineTool } from "@fadenstack/agents";

const searchIssues = defineTool<{ text: string }>({
  name: "search_issues",
  description: "Searches the issue tracker by text.",
  toolClass: "read",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  run: ({ text }) => findIssues(text), // your application's own lookup
});

const onRequest = new OnRequestTools([searchIssues, openIssue, closeIssue], {
  index: ["issues: search, open and close tickets in the tracker"],
});

const agent = FadenstackAgent.createBuilder()
  .useClient(client)
  .addTools(readPage)               // always offered
  .addToolSource(onRequest)         // offered on request
  .build();
```

While `OnRequestTools` has tools, the model gets one extra tool, `find_tool`, and none of the tools on request. The
`index` option adds lines to the description of `find_tool`, one per group, so the model knows what it can ask for.

## How the model finds a tool

`find_tool` takes one argument, `query`: a few words about what the model needs. The search ranks the tools on request by their names and descriptions and switches the best matches on for the rest of that conversation:

- It returns at most 5 tools (`MAX_FOUND`) and tells the model which: `Switched on 2 tools for this conversation. Call them with their parameters.` and a line per tool with its name and the start of its description. A search that matches nothing answers `No tool matched that search. Try other words.`
- The ranking is BM25 over the words of the name and the description. The name counts double, a plural ending is dropped (`issues` matches `issue`), and a name in camel case is split into words. A tool matches only if it shares at least one word with the query. The query is cut at 500 characters.
- At most 10 tools (`MAX_TOOLS_IN_SCOPE`) are on in one conversation. A new pick pushes out the one used least recently.
- The tools on are kept in memory, per session, for the most recent 200 sessions. After a restart of the application none are on.

A model that calls a tool by name before it is on gets an answer instead of a run: `search_issues is now switched on. Call it again with its parameters.` The tool is on from then, and the model calls it again. A tool whose definition changed since the model found it answers `changed its definition while you worked. Search for it again with find_tool.`

## What the contract and the modes do

The tools on request, and `find_tool` itself, are host tools, so the agent treats them like the tools you give to `addTools`:

- The agent's host tool contract on the server vouches for their class. A non-empty contract that does not list a tool drops it, `find_tool` included. A tool the contract lists without a `risk`, or any tool when the agent has no contract, is `unknown` and asks every time. List `find_tool` and each tool in the contract.
- The tool modes and approvals apply to a tool once it is on, as to any host tool. A tool that asks, asks.
- The app manifest reports the tools on request, `find_tool` first, so the server and its administrators see them. The source reports them through its `declared()` method.

An explicit [host command](host-commands.md) ignores the scope: the person asked for it, so there is nothing to switch on.

## Changing the tools

`OnRequestTools` is a `ChangingToolSource`. `set(tools)` replaces the tools, and the agent asks the source again at the start of its next turn, never inside one. A tool counts as on only while it is the same tool the source last handed out, so after a change the model finds the tools again. A tool that went away is refused with "(name) is no longer available." See [A source whose tools change](tools.md#a-source-whose-tools-change).

## When to use it

Use tools on request when there are many tools and the model needs few of them in one conversation: the request then carries `find_tool` and the tools found, not the whole list. For a handful of tools, add them with `addTools`.

The tools of the organisation's MCP servers are not host tools. They run on the server, and `client.agent.listTools()` lists them; see [The server's tools](tools.md#the-servers-tools).
