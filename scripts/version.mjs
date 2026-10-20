// The packages are released together, with one version. They pin each other to that exact version, and
// @fadenstack/client reports it as SDK_VERSION.
//
//   node scripts/version.mjs 0.2.0           sets the version everywhere; then run `npm install` for the lock
//   node scripts/version.mjs --check 0.2.0   fails unless everything says 0.2.0 (the release workflow)
//   node scripts/version.mjs --check         fails unless everything agrees
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const rootPackage = JSON.parse(readFileSync(`${root}package.json`, "utf8"));
const packageFiles = rootPackage.workspaces.map((dir) => `${root}${dir}/package.json`);
const manifestFile = `${root}packages/client/src/manifest.ts`;
const sdkVersionPattern = /export const SDK_VERSION = "([^"]*)";/;

const args = process.argv.slice(2);
const check = args[0] === "--check";
const wanted = check ? args[1] : args[0];

if (!check && !wanted) {
  console.error("Usage: node scripts/version.mjs <version> | --check [<version>]");
  process.exit(2);
}
if (wanted && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(wanted)) {
  console.error(`Not a version: ${wanted}`);
  process.exit(2);
}

const packages = packageFiles.map((file) => ({ file, json: JSON.parse(readFileSync(file, "utf8")) }));
const ours = new Set(packages.map((p) => p.json.name));
// Where a package names another of ours: @fadenstack/testing has agents and provenance as optional peers.
const pinFields = ["dependencies", "peerDependencies"];

if (check) {
  const expected = wanted ?? packages[0].json.version;
  const problems = [];
  for (const { json } of packages) {
    if (json.version !== expected) problems.push(`${json.name} is ${json.version}`);
    for (const field of pinFields) {
      for (const [name, range] of Object.entries(json[field] ?? {})) {
        if (ours.has(name) && range !== expected) problems.push(`${json.name} ${field}: ${name} ${range}`);
      }
    }
  }
  const sdkVersion = readFileSync(manifestFile, "utf8").match(sdkVersionPattern)?.[1];
  if (sdkVersion !== expected) problems.push(`SDK_VERSION is ${sdkVersion}`);
  if (problems.length) {
    console.error(`Expected ${expected} everywhere:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`All packages are ${expected}.`);
} else {
  for (const { file, json } of packages) {
    json.version = wanted;
    for (const field of pinFields) {
      for (const name of Object.keys(json[field] ?? {})) {
        if (ours.has(name)) json[field][name] = wanted;
      }
    }
    writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  }
  const manifest = readFileSync(manifestFile, "utf8");
  writeFileSync(manifestFile, manifest.replace(sdkVersionPattern, `export const SDK_VERSION = "${wanted}";`));
  console.log(`Set ${wanted}. Run \`npm install\` to update package-lock.json.`);
}
