# Contributing to the Fadenstack TypeScript SDK

Thank you for helping. This page says how to ask, report and propose changes, and what a pull request needs.

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Questions

Read the [documentation](https://developers.fadenstack.com/sdk/typescript/) first. If it does not answer your
question, open an issue with the **Question** template. Questions about the server itself belong in
[fadenstack/fadenstack](https://github.com/fadenstack/fadenstack/issues).

## Reporting a bug

1. Search the [issues](https://github.com/fadenstack/fadenstack-sdk-typescript/issues) to see whether it is known.
   If it is, add what you know there instead of opening a new one.
2. Open an issue with the **Bug report** template. Say which package version you use, where it runs (the browser
   and its version, an extension, Node.js), which server release you talk to (`faden version` on the server), what
   you did, what you expected and what happened instead. A small script or page that shows the problem helps most.
3. Leave out passwords, tokens, API keys and personal data. Shorten logs to the part that matters.

A **security problem** is not reported in an issue: see [SECURITY.md](SECURITY.md).

## Proposing a change or a feature

Open an issue with the **Feature request** template before you write code, and describe the problem you want to
solve rather than only the solution. We say there whether it fits and how we would like it done, so your work is
not wasted. Small fixes (a typo, a broken link) can go straight to a pull request.

## Pull requests

- **Link the issue** it resolves ("Fixes #123"). A bug fix needs an issue that describes the bug; a feature needs
  an issue we agreed on.
- **One change per pull request**, as small as it can be.
- **Tests:** add or change tests that show the change works, and run `npm run typecheck` and `npm test`.
- **Documentation:** when you change what a developer sees or does, change the page in `docs/`.
- **Runtimes:** the packages run in browsers and in Node.js 24 or later, on standard web APIs only. Don't add
  Node-only APIs or new dependencies to the library packages without agreeing it in the issue first. A change to a
  public API that breaks existing code needs to be agreed there too.
- **Commit messages** say what the change does, in a plain sentence ("Agents: a declined tool call ends the
  turn"), with the reason in the body when it is not obvious.
- **No confidential information**: nothing about your company, clients or systems that you don't want public.

### Contributor licence agreement

Before we can merge your first pull request, you sign the
[contributor licence agreement](CONTRIBUTOR_LICENSE_AGREEMENT.md) once. When you open the pull request, the CLA
Assistant bot comments on it with a link; you read the agreement there and sign with your GitHub account. It is
three sentences long: you let Emagin8 UG (haftungsbeschränkt), Fadenstack's steward, license your contribution on
any terms, and you give it without warranty. If your employer or a client has rights in your work, make sure you
may sign.

## Architecture rules

The SDK is built in layers. `packages/testing/test/architecture.test.ts` fails when a change breaks one of these rules,
so they show up in `npm test`:

| Layer | Packages | May depend on |
|---|---|---|
| 1 · Connection | `@fadenstack/client` | no other package of the SDK |
| 2 · Agent runtime | `@fadenstack/agents` | client |
| 3 · Modules | `@fadenstack/provenance` (and later `skills`, `mcp`, `web-search`) | agents and client, never another module or the UI |
| 4 · UI logic | `@fadenstack/ui`; `@fadenstack/ui-web` (the web look) | agents and client; ui-web also ui |
| 5 · Skins | `@fadenstack/ui-react`, `@fadenstack/ui-vue` | ui, ui-web, agents, client; never a module directly |

- **Dependencies and imports point down only**, and React and Vue are imported only in their own skin. A new package
  needs its row in the test.
- **No browser API in `@fadenstack/ui` and the modules**: no `window`, `document`, DOM types or `localStorage`. View
  models are headless; a host or `ui-web` injects the browser's services (opening a link, the clipboard, storage).
- **A module owns its texts**, in the SDK's five languages (English, German, French, Spanish, Simplified Chinese),
  never in the UI package.
- **No text is written in a skin**: every text comes from `UiStrings`.
- `packages/testing/test/architecture-allowlist.json` lists what is allowed anyway, each entry with its reason; an
  entry that no longer matches anything fails the test.

The rules come from the maintainers' SDK architecture note (sdk/52).

## Setting up for development

You need Node.js 24 or later and git.

```bash
git clone https://github.com/fadenstack/fadenstack-sdk-typescript.git
cd fadenstack-sdk-typescript
npm install
npm test            # vitest, against the sources
npm run typecheck
npm run build       # each package's dist/
```

The tests run against `@fadenstack/testing`, a fake server, and need no Fadenstack installation. To preview the
documentation: `pip install zensical`, then `zensical serve`.

## Licence

The SDK is licensed under the [Apache License 2.0](LICENSE). Your contribution is licensed under it too, and the
contributor licence agreement above adds the steward's right to license it on other terms.
