import { FadenstackClient, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore, defineTool } from "@fadenstack/agents";
import { AgentChatViewModel, ApprovalBroker, MemoryClipboard, immediateScheduler, type AgentChatOptions } from "@fadenstack/ui";
import { FakeGateway, lastToolResults, type FakeModel } from "@fadenstack/testing";

/** A chat (signed in unless `signIn` is false) with "Page assistant": read_page (read) and fill_field (write, or destructive). */
export async function chatWith(model: FakeModel, options: AgentChatOptions = {}, risk: "write" | "destructive" = "write", signIn = true) {
  const gateway = new FakeGateway({
    agents: [{
      slug: "page", name: "Page assistant", ui: { greeting: "I read the page you are on.", suggestions: ["Summarise this page"] },
      contract: [{ name: "fill_field", risk }, { name: "read_page", risk: "read" }],
    }],
    model,
  });
  const { client, tokens } = FadenstackClient.forAgent({ serverUrl: gateway.serverUrl, agent: "page", fetch: gateway.fetch });
  if (signIn) await tokens.signIn(await loginWithPassword({ apiUrl: gateway.serverUrl, email: "user@example.com", password: "secret", fetch: gateway.fetch }));
  const filled: string[] = [];
  const approvals = new ApprovalBroker();
  const agent = FadenstackAgent.createBuilder()
    .useClient(client)
    .useSessionStore(new MemorySessionStore())
    .useApprovals(approvals)
    .addTools(
      defineTool({ name: "read_page", toolClass: "read", run: () => "The page text." }),
      defineTool<{ value: string }>({
        name: "fill_field", toolClass: "write",
        parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
        run: ({ value }) => {
          filled.push(value);
          return "filled";
        },
      }),
    )
    .build();
  const clipboard = new MemoryClipboard();
  const chat = new AgentChatViewModel(agent, approvals, { scheduler: immediateScheduler, clipboard, locale: "en-GB", ...options });
  await chat.initialize();
  return { chat, filled, clipboard, gateway };
}

/** Every kind of Markdown an answer has. */
export const richAnswer = [
  "## Heading", "", "A **bold** _em_ ~~del~~ `code` [link](https://example.com) ![alt](https://example.com/x.png) and ![](https://example.com/y.png)", "",
  "- one", "- [x] done", "", "1. first", "2. second", "", "> quoted", "", "```js", "let x = 1;", "```", "",
  "| A | B |", "|:--|--:|", "| 1 | 2 |", "", "---",
].join("\n");

/** Reads the page, asks to fill a field, then answers with reasoning, references and `richAnswer`. */
export const readFillAnswer: FakeModel = (r) => {
  const results = new Set(lastToolResults(r).values());
  if (results.has("filled")) {
    return {
      reasoning: "The field is filled; now the summary.",
      events: [{ type: "CUSTOM", name: "faden.citations", value: { sources: [{ source: "Manual.pdf", chunk: 3 }, { document_id: "doc-7" }] } }],
      text: richAnswer,
    };
  }
  if (results.has("The page text.")) return { toolCalls: [{ name: "fill_field", arguments: { value: "Jane" } }] };
  return { text: "Reading.", toolCalls: [{ name: "read_page" }] };
};

/** Polls until `check` holds (the agent runs on its own). */
export async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error("Timed out waiting.");
    await new Promise((r) => setTimeout(r, 2));
  }
}

/**
 * An element as comparable text: no comments (Vue's v-if placeholders), adjacent text merged, attributes sorted,
 * styles sorted, generated ids numbered, and the state a property holds (a box's value, a tick).
 */
export function normalize(root: Element): string {
  const copy = root.cloneNode(true) as Element;
  const walker = copy.ownerDocument.createTreeWalker(copy, 128 /* NodeFilter.SHOW_COMMENT */);
  const comments: Node[] = [];
  while (walker.nextNode()) comments.push(walker.currentNode);
  for (const c of comments) c.parentNode?.removeChild(c);
  copy.normalize();
  const ids = new Map<string, string>();
  const id = (value: string) => {
    if (!ids.has(value)) ids.set(value, `id${ids.size}`);
    return ids.get(value)!;
  };
  for (const el of [copy, ...Array.from(copy.querySelectorAll("[id]"))]) if (el.id) id(el.id);
  const lines: string[] = [];
  const walk = (node: Node, depth: number) => {
    const pad = "  ".repeat(depth);
    if (node.nodeType === 3) {
      lines.push(`${pad}${JSON.stringify(node.textContent)}`);
      return;
    }
    const el = node as Element;
    // React keeps a text box's text as its content, Vue as its value attribute: only the live value counts.
    const isBox = el instanceof HTMLTextAreaElement;
    const attrs = Array.from(el.attributes).filter((a) => !(isBox && a.name === "value")).map((a) => {
      let value = a.value;
      if (a.name === "style") value = value.split(";").map((d) => d.trim().replace(/\s*:\s*/, ":")).filter(Boolean).sort().join(";");
      if (a.name === "id") value = id(value);
      if (a.name === "mask") value = value.replace(/url\(#([^)]+)\)/, (_, ref: string) => `url(#${id(ref)})`);
      return `${a.name}=${JSON.stringify(value)}`;
    });
    // A clone carries a text box value and a tick, which are properties, not attributes.
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) attrs.push(`.value=${JSON.stringify(el.value)}`);
    if (el instanceof HTMLInputElement && el.type === "checkbox") attrs.push(`.checked=${el.checked}`);
    lines.push(`${pad}<${el.tagName.toLowerCase()} ${attrs.sort().join(" ")}>`);
    if (!isBox) for (const child of Array.from(el.childNodes)) walk(child, depth + 1);
  };
  walk(copy, 0);
  return lines.join("\n");
}
