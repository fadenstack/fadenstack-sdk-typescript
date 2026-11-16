// Writes THIRD-PARTY-NOTICES at the repository's root and into every package (each package's `files` lists it):
// first what the packages carry inside them that others made (icon paths, a root certificate), then the packages npm
// installs with ours (their dependencies and theirs, with versions and licences, never the dev dependencies), and the
// ones an app brings itself (peer dependencies). The installed ones are not part of our packages: npm fetches each
// with its own licence text; an app that bundles them (a browser extension) lists them in its own notices.
//
//   node scripts/third-party-notices.mjs           writes the files (run after `npm install` changes a dependency)
//   node scripts/third-party-notices.mjs --check   fails unless every file is current (the release workflow)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "THIRD-PARTY-NOTICES";
const RULE = "=".repeat(100);

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const rootPackage = readJson(join(root, "package.json"));
const workspaces = rootPackage.workspaces.map((dir) => ({ dir, pkg: readJson(join(root, dir, "package.json")) }));
const ours = new Set(workspaces.map((w) => w.pkg.name));

/** What the packages carry inside them that others made. Kept by hand: a change to it is a change to this text. */
const BUNDLED = `== Carried inside the packages ==

@fadenstack/ui-web: icons (packages/ui-web/src/icons.ts)
  Most of the chat's icons are the SVG path data of Google's Material Icons
  (https://github.com/google/material-design-icons), some of them changed. Only the path data is carried; no font
  or package of Google's is shipped.
  Copyright Google LLC. Licensed under the Apache License, Version 2.0 (the "License"); you may not use these files
  except in compliance with the License. You may obtain a copy of the License at
  http://www.apache.org/licenses/LICENSE-2.0
  Unless required by applicable law or agreed to in writing, software distributed under the License is distributed
  on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for
  the specific language governing permissions and limitations under the License.

@fadenstack/provenance: a root certificate (packages/provenance/src/timestampRoots.ts)
  DigiCert Trusted Root G4 (CN=DigiCert Trusted Root G4, OU=www.digicert.com, O=DigiCert Inc, C=US), the public
  root certificate DigiCert's time-stamping service chains to, carried unchanged as a trust anchor so that a
  time-stamp can be checked.
`;

/** A package's folder, as Node would find it from `from` (a nested node_modules first). */
function packageDir(name, from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

function licenceOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(" OR ");
  return "UNKNOWN";
}

/**
 * What npm installs with one of our packages: its dependencies that are not ours, then theirs, through our own
 * packages too (an app installing @fadenstack/ui gets marked through it). Optional dependencies are left out (native
 * helpers a browser never takes in); peer dependencies the app brings, so they are listed apart.
 */
function installedWith(start) {
  const found = new Map();
  const queue = [];
  const visitedOurs = new Set();
  const enqueueOf = (pkg, dir) => {
    const optional = new Set(Object.keys(pkg.optionalDependencies ?? {}));
    for (const dep of Object.keys(pkg.dependencies ?? {})) if (!optional.has(dep)) queue.push([dep, dir]);
  };
  enqueueOf(start.pkg, join(root, start.dir));
  while (queue.length) {
    const [name, from] = queue.shift();
    if (ours.has(name)) {
      if (visitedOurs.has(name)) continue;
      visitedOurs.add(name);
      const w = workspaces.find((x) => x.pkg.name === name);
      enqueueOf(w.pkg, join(root, w.dir));
      continue;
    }
    const dir = packageDir(name, from);
    if (!dir) continue; // not installed: not part of what npm installs here
    const pkg = readJson(join(dir, "package.json"));
    const key = `${pkg.name}@${pkg.version}`;
    if (found.has(key)) continue;
    found.set(key, { name: pkg.name, version: pkg.version, licence: licenceOf(pkg) });
    enqueueOf(pkg, dir);
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** The peer dependencies of ours that are not ours: the app brings them (React, Vue). */
function peers(start) {
  return Object.entries(start.pkg.peerDependencies ?? {})
    .filter(([name]) => !ours.has(name))
    .map(([name, range]) => {
      const dir = packageDir(name, join(root, start.dir));
      return { name, range, licence: dir ? licenceOf(readJson(join(dir, "package.json"))) : "UNKNOWN" };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function render() {
  const lines = [
    "Third-party notices for the Fadenstack TypeScript SDK",
    "",
    "The @fadenstack packages are Apache-2.0 (LICENSE, NOTICE). This file names what others made: what the packages",
    "carry inside them, and the packages npm installs with them, which keep their own licences and are not part of",
    `ours. Generated by scripts/third-party-notices.mjs from the installed packages; the release checks it is current.`,
    "",
    RULE,
    BUNDLED.trimEnd(),
    "",
    RULE,
    "== Installed with the packages (not carried inside them) ==",
    "",
  ];
  for (const w of [...workspaces].sort((a, b) => a.pkg.name.localeCompare(b.pkg.name))) {
    const installed = installedWith(w);
    const brought = peers(w);
    lines.push(`${w.pkg.name}`);
    if (installed.length === 0 && brought.length === 0) lines.push("  nothing but @fadenstack packages");
    for (const d of installed) lines.push(`  ${d.name} ${d.version} (${d.licence})`);
    for (const p of brought) lines.push(`  ${p.name} ${p.range} (${p.licence}), brought by the app (peer dependency)`);
    lines.push("");
  }
  return lines.join("\n");
}

const text = render();
const targets = [join(root, NAME), ...workspaces.map((w) => join(root, w.dir, NAME))];
const missingFromFiles = workspaces.filter((w) => !(w.pkg.files ?? []).includes(NAME)).map((w) => w.pkg.name);

if (process.argv.includes("--check")) {
  const stale = targets.filter((file) => !existsSync(file) || readFileSync(file, "utf8") !== text);
  if (stale.length || missingFromFiles.length) {
    for (const file of stale) console.error(`Not current: ${file.slice(root.length + 1)}`);
    for (const name of missingFromFiles) console.error(`${name}: its package.json "files" does not list ${NAME}`);
    console.error("Run: node scripts/third-party-notices.mjs");
    process.exit(1);
  }
  console.log(`${NAME} is current (${targets.length} files).`);
} else {
  for (const file of targets) writeFileSync(file, text);
  if (missingFromFiles.length) console.error(`Add ${NAME} to "files" in: ${missingFromFiles.join(", ")}`);
  console.log(`Wrote ${NAME} (${targets.length} files).`);
}
