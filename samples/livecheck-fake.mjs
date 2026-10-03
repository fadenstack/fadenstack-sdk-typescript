// Runs livecheck.mjs against the fake server over HTTP: proves the live check itself before a real server.
//   node samples/livecheck-fake.mjs
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

import { FakeGateway, lastToolResults, lastUserText } from "@fadenstack/testing";

const contract = JSON.parse(readFileSync(new URL("../../faden-agent-chrome/contracts/browser-assistant.json", import.meta.url), "utf8"));
const gateway = new FakeGateway({
  agents: [{ slug: contract.slug, name: contract.name, contract: contract.version.host_tool_contract }],
  users: [{ email: "check@example.com", password: "pw" }],
  model: (request) => {
    const asked = lastUserText(request);
    const results = [...lastToolResults(request).values()];
    if (results.length) return { text: /Filled/.test(results[0]) ? "Done." : "The seal is checked every 2 000 h." };
    if (/read_context/.test(asked)) return { toolCalls: [{ name: "read_context", arguments: { id: "page:document" } }] };
    if (/fill_field/.test(asked)) {
      const second = asked.includes("e2");
      return { toolCalls: [{ name: "fill_field", arguments: { ref: second ? "e2" : "e1", value: second ? "X" : "Jane Doe" } }] };
    }
    return { text: "Hello there, nice to meet you." };
  },
});
const server = await gateway.listen(0);
const child = spawn(process.execPath, [new URL("./livecheck.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  "--server", server.url, "--agent", contract.slug], {
  env: { ...process.env, FADEN_USER_EMAIL: "check@example.com", FADEN_USER_PASSWORD: "pw" },
  stdio: "inherit",
});
const code = await new Promise((resolve) => child.on("exit", resolve));
await server.close();
process.exit(code ?? 1);
