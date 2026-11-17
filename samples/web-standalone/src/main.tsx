// The standalone sample page: a person picks their own model endpoint with the SDK's connection wizard, then chats with an
// agent that has one tool. The tool saves a note into the page's own list and asks first (Ask mode), content marking is on,
// "Stop everything" sits in the header, and "Your data in this browser" opens from the panel's settings menu.
// Run it: `npm run sample:web`. See samples/README.md for Ollama and LM Studio.
import { useEffect, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

import {
  AgentChatViewModel,
  ApprovalBroker,
  ConnectionWizardViewModel,
  MyDataSettingsViewModel,
  StopEverythingViewModel,
  WizardOutcome,
  stringsFor,
} from "@fadenstack/ui";
import { ConnectionWizard } from "@fadenstack/ui-react";
import { browserChatServices, browserSaveFile } from "@fadenstack/ui-web";
import "@fadenstack/ui-web/styles.css";

import { Page, type Running } from "./page.js";
import { BrowserKeyStore, Notes, PageConnectionStore, buildSampleAgent } from "./sample.js";

const notes = new Notes();
const strings = stringsFor(navigator.language);

/** The wizard: "Use my own AI" only (there is no server on this page), with the key kept by the SDK's own protection. */
const store = new PageConnectionStore();
const wizard = new ConnectionWizardViewModel(
  { appName: "Standalone sample", offersServer: false, offersOwnAi: true, canSearchThisComputer: false, termsVersion: "2026-11" },
  store,
  { keys: new BrowserKeyStore(), strings, language: () => navigator.language },
);

async function connect(): Promise<Running | undefined> {
  const result = store.result;
  if (!result?.endpoint) return undefined;
  const approvals = new ApprovalBroker(); // approval cards in the chat decide
  const agent = buildSampleAgent({ endpoint: result.endpoint, report: result.report, approvals, notes });
  const chat = new AgentChatViewModel(agent, approvals, {
    ...browserChatServices(), // the browser's clipboard, links, downloads and kept choices
    automaticLanguage: navigator.languages,
    locale: navigator.language,
  });
  await chat.initialize();
  const myData = new MyDataSettingsViewModel({ agent, strings: () => chat.strings });
  myData.onSaveRequest((request) => {
    void browserSaveFile({ name: request.fileName, type: request.kind === "audit" ? "text/html" : "application/json", content: request.text });
  });
  await myData.load();
  return { agent, chat, stop: new StopEverythingViewModel({ agents: () => [agent], strings: () => chat.strings }), myData };
}

function App(): ReactElement {
  const [running, setRunning] = useState<Running | undefined>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const off = wizard.onCompleted((outcome) => {
      if (outcome !== WizardOutcome.Connected) return;
      connect().then(setRunning, () => setFailed(true));
    });
    void wizard.start();
    return off;
  }, []);
  if (running) return <Page running={running} notes={notes} />;
  if (failed) return <p role="alert">The page could not start the agent. Reload it and try again.</p>;
  return <ConnectionWizard wizard={wizard} appName="Standalone sample" />;
}

createRoot(document.getElementById("root")!).render(<App />);
