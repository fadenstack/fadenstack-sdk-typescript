// Drives the SDK against a running Fadenstack server and says, check by check, what works -- the TypeScript
// counterpart of the .NET LiveCheck. Needs the packages built (npm run build) and an agent whose contract has the
// browser agent's tools (faden-agent-chrome/contracts/browser-assistant.json), granted to the user.
//
//   FADEN_USER_EMAIL=... FADEN_USER_PASSWORD=... NODE_EXTRA_CA_CERTS=ca.crt \
//     node samples/livecheck.mjs --server https://faden.example --agent browser-assistant
//
// Over https only, or plain http to this machine; --allow-http allows plain http to another (a development server):
// the password and the tokens then cross the network readable.
import { AgentTokenProvider, FadenstackClient, MemoryTokenStore, loginWithPassword } from "@fadenstack/client";
import { FadenstackAgent, MemorySessionStore, defineTool } from "@fadenstack/agents";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const server = arg("server", process.env.FADEN_SERVER);
const agentSlug = arg("agent", "browser-assistant");
const allowInsecureHttp = process.argv.includes("--allow-http");
const email = process.env.FADEN_USER_EMAIL;
const password = process.env.FADEN_USER_PASSWORD;
if (!server || !email || !password) {
  console.error("Usage: FADEN_USER_EMAIL=... FADEN_USER_PASSWORD=... node samples/livecheck.mjs --server https://... [--agent slug] [--allow-http]");
  process.exit(2);
}

const results = [];
async function check(name, run) {
  const started = Date.now();
  try {
    const detail = await run();
    results.push({ name, ok: true });
    console.log(`PASS ${name} (${Date.now() - started} ms)${detail ? ` -- ${detail}` : ""}`);
  } catch (error) {
    results.push({ name, ok: false });
    console.log(`FAIL ${name} (${Date.now() - started} ms) -- ${error?.message ?? error}`);
  }
}

const store = new MemoryTokenStore();
const tokens = new AgentTokenProvider({ apiUrl: server, agent: agentSlug, store, allowInsecureHttp });
const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(server).hostname);
const client = new FadenstackClient({ serverUrl: server, agent: agentSlug, credentials: tokens, allowInsecureHttp: allowInsecureHttp || local });
const filled = [];
const page = "# Pump P-200 maintenance guide\n\n| Task | Interval |\n| --- | --- |\n| Seal check | 2 000 h |\n| Bearing lubrication | 4 000 h |";
const agent = FadenstackAgent.createBuilder()
  .useClient(client)
  .useSessionStore(new MemorySessionStore())
  .addTools(
    defineTool({
      name: "read_context", toolClass: "read", description: "Reads context by id, e.g. page:document.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: ({ id }) => (String(id).startsWith("page") ? `[page:document — Pump guide]\n${page}` : `No context '${id}'.`),
    }),
    defineTool({
      name: "fill_field", toolClass: "write", description: "Fills a field on the page by its ref.",
      parameters: { type: "object", properties: { ref: { type: "string" }, value: { type: "string" } }, required: ["ref", "value"] },
      run: ({ ref, value }) => {
        filled.push(`${ref}=${value}`);
        return `Filled ${ref}.`;
      },
    }),
  )
  .useApprovals(async () => ({ approved: true }))
  .useReasoning("none")
  .build();

await check("signin", async () => {
  const login = await loginWithPassword({ apiUrl: server, email, password, allowInsecureHttp });
  const set = await tokens.signIn(login, "Fadenstack TypeScript LiveCheck");
  return `device ${set.deviceId}`;
});

await check("profile", async () => {
  await agent.start();
  const p = agent.profile;
  return `${p.name} v${p.version}, model ${p.model}, tools ${agent.tools.map((t) => `${t.name}:${t.toolClass}`).join(" ")}`;
});

await check("chat", async () => {
  const session = await agent.startSession();
  let text = "";
  for await (const e of session.stream("Say hello in five words.")) if (e.type === "text") text += e.text;
  if (!text.trim()) throw new Error("no answer");
  return JSON.stringify(text.trim().slice(0, 60));
});

await check("host-read", async () => {
  const session = await agent.startSession();
  const result = await session.send("Read the page with read_context (id page:document). How often is the seal checked? Answer in one sentence.");
  const ran = session.transcript.some((e) => e.type === "tool.execution_complete" && e.data.name === "read_context");
  if (!ran) throw new Error(`read_context did not run (outcome ${result.outcome}): ${result.text.slice(0, 80)}`);
  if (!/2[ .,]?000/.test(result.text)) throw new Error(`answer misses the interval: ${result.text.slice(0, 120)}`);
  return JSON.stringify(result.text.trim().slice(0, 80));
});

await check("ask-approve", async () => {
  const session = await agent.startSession("ask");
  const result = await session.send("Call fill_field with ref e1 and value Jane Doe now. Do not ask me first.");
  if (!filled.includes("e1=Jane Doe")) throw new Error(`fill_field did not run (outcome ${result.outcome})`);
  const asked = session.transcript.some((e) => e.type === "approval.decision" && e.data.approved === true);
  if (!asked) throw new Error("it ran without an approval in ask mode");
  return "asked, approved, ran";
});

await check("read-only-hides-writes", async () => {
  const before = filled.length;
  const session = await agent.startSession("read_only");
  const result = await session.send("Call fill_field with ref e2 and value X.");
  if (filled.length !== before) throw new Error("a write tool ran in read_only");
  return `outcome ${result.outcome}`;
});

await check("refresh", async () => {
  const before = await tokens.getAccessToken();
  await tokens.invalidate(before);
  const after = await tokens.getAccessToken();
  if (after === before) throw new Error("the token was not renewed");
  await agent.client.agent.getProfile();
  return "renewed and used";
});

await check("events", async () => {
  await agent.flush();
  if (agent.lastReportError) throw agent.lastReportError;
  return "reported without error";
});

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed.`);
process.exit(failed ? 1 : 0);
