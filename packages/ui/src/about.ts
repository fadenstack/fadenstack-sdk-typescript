import { SDK_VERSION } from "@fadenstack/client";

import type { UiStrings } from "./strings.js";

/**
 * The panel's links back to Fadenstack, and what About shows. A link to fadenstack.com carries two things only:
 * `ref`, which says where the click came from (`sdk-panel`, `office-about`), and `v`, the SDK's major.minor version.
 * Never a user, an organisation, a server, an agent or anything a person typed.
 */

/** The brand, which is never translated. */
export const FADENSTACK = "Fadenstack";
/** Fadenstack's website. */
export const FADENSTACK_WEBSITE = "https://fadenstack.com/";
/** The SDKs' documentation. */
export const FADENSTACK_DEVELOPERS = "https://developers.fadenstack.com/";
/** The `refSource` of a panel whose host names none, or names one that is not allowed. */
export const DEFAULT_REF_SOURCE = "sdk";

const REF_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const REF_SOURCE_MAX = 20;
const REF_MAX = 40;

/** A link the panel shows: its text, and where it goes. It opens in a new tab. */
export interface PanelLink {
  label: string;
  href: string;
}

/**
 * The app part of `ref` (`office`, `chrome`, `my-crm`): lower-case letters and digits in words joined by single
 * hyphens, at most 20 characters. Anything else is `sdk`.
 */
export function refSource(value: unknown): string {
  return typeof value === "string" && value.length <= REF_SOURCE_MAX && REF_PATTERN.test(value) ? value : DEFAULT_REF_SOURCE;
}

/** The first two numbers of a version (`0.4.5` and `0.2.0-rc.3` are `0.4` and `0.2`); undefined when it has none. */
export function majorMinor(version: string | null | undefined): string | undefined {
  const match = typeof version === "string" ? /^v?(\d{1,6})\.(\d{1,6})(?:[.+-]|$)/.exec(version.trim()) : null;
  return match ? `${Number(match[1])}.${Number(match[2])}` : undefined;
}

/**
 * A page of Fadenstack's (`FADENSTACK_WEBSITE`, `FADENSTACK_DEVELOPERS`) with `?ref=<ref>&v=<major.minor>`, and
 * nothing else. `version` is this SDK's by default; `v` is left out for `null` or a version without a major.minor.
 * Throws for a `ref` that is not a plain tag.
 */
export function fadenstackLink(page: string, ref: string, version: string | null | undefined = SDK_VERSION): string {
  if (ref.length > REF_MAX || !REF_PATTERN.test(ref)) throw new RangeError(`Not a ref: ${JSON.stringify(ref)}.`);
  const url = new URL(page);
  url.search = "";
  url.hash = "";
  const v = majorMinor(version);
  return `${url.href}?ref=${ref}${v ? `&v=${v}` : ""}`;
}

/** The muted link on the AI-notice line: the website, `ref=<app>-panel`. */
export function footerLink(source?: string, sdkVersion: string = SDK_VERSION): PanelLink {
  return { label: FADENSTACK, href: fadenstackLink(FADENSTACK_WEBSITE, `${refSource(source)}-panel`, sdkVersion) };
}

/** The organisation's own Help, on the agent's server: `<server>/help/`, without a ref. */
export function helpLink(server: string | URL): string {
  const url = new URL(server);
  return `${url.origin}${url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`}help/`;
}

/** A server's address as About shows it: no sign-in, query or fragment, and no slash at the end. */
export function serverAddress(server: string | URL): string {
  const url = new URL(server);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** The SDK as About names it. */
export function sdkName(version: string = SDK_VERSION): string {
  return `${FADENSTACK} SDK ${version} (TypeScript)`;
}

/** What About shows, before it is put in words. */
export interface AboutFacts {
  /** The agent, once it started. */
  agent?: { name: string; version: number | null; draft: boolean; model: string | null } | undefined;
  /** The app the agent runs in, when the host described it (`describeApp`). */
  app?: { name: string; version?: string | undefined } | undefined;
  /** The agent's server. */
  server?: string | URL | undefined;
  /** The host's `refSource`; `sdk` by default. */
  refSource?: string | undefined;
  /** This SDK's version, by default. */
  sdkVersion?: string | undefined;
}

/** About, in the panel's language. */
export interface AboutView {
  /** The agent's name; empty before it started. */
  agent: string;
  /** Under the name: its version ("Version 3", or "Draft") and its model, when the server says them. */
  agentDetails: readonly string[];
  /** The app it runs in (when the host described it), the SDK, and the server's address. */
  environment: readonly string[];
  /** Help (the organisation's), the website and the developer docs. */
  links: readonly PanelLink[];
  /** All of it as text lines, for "Copy details". */
  text: string;
}

/** About from its facts and the panel's texts. */
export function aboutView(facts: AboutFacts, strings: UiStrings): AboutView {
  const agent = facts.agent;
  const agentDetails: string[] = [];
  if (agent?.draft) agentDetails.push(strings.aboutDraft);
  else if (typeof agent?.version === "number") agentDetails.push(strings.aboutVersion(agent.version));
  if (agent?.model) agentDetails.push(strings.aboutModel(agent.model));

  const sdkVersion = facts.sdkVersion ?? SDK_VERSION;
  const environment: string[] = [];
  const app = facts.app && [facts.app.name.trim(), facts.app.version?.trim()].filter(Boolean).join(" ");
  if (app) environment.push(strings.aboutApp(app));
  environment.push(sdkName(sdkVersion));
  const server = facts.server === undefined ? undefined : safely(() => serverAddress(facts.server!));
  if (server) environment.push(strings.aboutServer(server));

  const ref = `${refSource(facts.refSource)}-about`;
  const help = facts.server === undefined ? undefined : safely(() => helpLink(facts.server!));
  const links: PanelLink[] = [
    ...(help ? [{ label: strings.help, href: help }] : []),
    { label: FADENSTACK, href: fadenstackLink(FADENSTACK_WEBSITE, ref, sdkVersion) },
    { label: strings.developerDocs, href: fadenstackLink(FADENSTACK_DEVELOPERS, ref, sdkVersion) },
  ];
  const name = agent?.name ?? "";
  return { agent: name, agentDetails, environment, links, text: [name, ...agentDetails, ...environment].filter(Boolean).join("\n") };
}

function safely<T>(make: () => T): T | undefined {
  try {
    return make();
  } catch {
    return undefined;
  }
}
