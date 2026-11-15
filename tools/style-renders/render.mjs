// Renders the wizard and the skill views of both web skins (React, Vue) in light, dark and forced colours at the width of Office's
// pane (380 CSS px), checks them in the browser, and composes before | after pictures. Opt-in tooling; not part of `npm test`.
//
//   node tools/style-renders/render.mjs render  <outDir> [--skin react|vue] [--palette light|dark|forced] [--only view[:state]] [--no-checks]
//   node tools/style-renders/render.mjs compose <beforeDir> <afterDir> <outDir>
//
// Playwright is not a dependency of this repo: it is loaded from FADEN_PLAYWRIGHT (the folder of an installed `playwright` package;
// default: the Chrome agent's node_modules). The browsers are the ones Playwright already installed under %LOCALAPPDATA%\ms-playwright.
// The page is built with Vite into tools/style-renders/dist (ignored by git) and served from a tiny local server that is closed at the end.

import { createRequire } from "node:module";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PLAYWRIGHT = "C:\\00_Code\\80_llm.port\\fadenstack\\faden-agent-chrome\\node_modules\\playwright";
const playwrightDir = process.env.FADEN_PLAYWRIGHT ?? DEFAULT_PLAYWRIGHT;
const { chromium } = createRequire(join(playwrightDir, "package.json"))(playwrightDir);

const SKINS = ["react", "vue"];
const PALETTES = ["light", "dark", "forced"];
const WIDTH = 380;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2" };

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function build() {
  const vite = await import(pathToFileURL(resolve(here, "../../node_modules/vite/dist/node/index.js")).href);
  await vite.build({ configFile: join(here, "vite.config.ts") });
}

function serve(dir) {
  const server = createServer((req, res) => {
    const path = join(dir, decodeURIComponent((req.url ?? "/").split("?")[0]).replace(/^\/+$/, "/index.html"));
    if (!path.startsWith(dir) || !existsSync(path) || !statSync(path).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream" }).end(readFileSync(path));
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

const safe = (s) => s.replace(/[^\w.-]+/g, "_");

async function render(out) {
  const onlySkin = arg("skin");
  const onlyPalette = arg("palette");
  const only = arg("only");
  const checksOn = !process.argv.includes("--no-checks");
  await build();
  const server = await serve(join(here, "dist"));
  const url = `http://127.0.0.1:${server.address().port}/index.html`;
  console.log(`serving ${url} (this process, pid ${process.pid})`);
  const browser = await chromium.launch();
  const report = { failures: {}, stats: {}, counts: {} };
  let failed = 0;
  try {
    for (const palette of PALETTES) {
      if (onlyPalette && onlyPalette !== palette) continue;
      for (const skin of SKINS) {
        if (onlySkin && onlySkin !== skin) continue;
        const context = await browser.newContext({ viewport: { width: WIDTH, height: 800 }, deviceScaleFactor: 2, colorScheme: palette === "dark" ? "dark" : "light" });
        const page = await context.newPage();
        const problems = [];
        page.on("pageerror", (e) => problems.push(String(e)));
        await page.emulateMedia({ forcedColors: palette === "forced" ? "active" : "none" });
        await page.goto(url);
        await page.waitForFunction(() => window.styleRenders);
        const states = await page.evaluate(() => window.styleRenders.states);
        const dir = join(out, skin, palette);
        mkdirSync(dir, { recursive: true });
        let count = 0;
        for (const [view, list] of Object.entries(states)) {
          for (const state of list) {
            if (only && only !== view && only !== `${view}:${state}`) continue;
            const name = `${view}-${state}`;
            const height = await page.evaluate(([s, v, st, p]) => window.styleRenders.show(s, v, st, p), [skin, view, state, palette]);
            await page.setViewportSize({ width: WIDTH, height: Math.max(120, height) });
            await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
            if (checksOn) {
              const { failures, stats } = await page.evaluate((p) => window.styleRenders.runChecks(p), palette);
              // The focus ring of every control, by keyboard (Tab from the page start).
              await page.evaluate(() => window.styleRenders.blur());
              const n = await page.evaluate(() => window.styleRenders.tabbableCount());
              for (let i = 0; i < n; i++) {
                await page.keyboard.press("Tab");
                const f = await page.evaluate(() => window.styleRenders.measureFocus());
                if (!f) continue;
                if (!f.ring) failures.push({ kind: palette === "forced" ? "forced-focus" : "focus-ring", where: f.where, detail: `no visible focus ring (outline ${f.style} ${f.width}px)` });
                else if (palette !== "forced") {
                  if (!stats.minFocus || f.ratio < stats.minFocus.ratio) stats.minFocus = { ratio: f.ratio, where: f.where };
                  if (f.ratio < 3) failures.push({ kind: "focus-ring", where: f.where, detail: `${f.ratio.toFixed(2)}:1 needs 3:1` });
                }
              }
              await page.evaluate(() => window.styleRenders.blur());
              if (failures.length) report.failures[`${skin}/${palette}/${name}`] = failures;
              failed += failures.length;
              const key = `${skin}/${palette}`;
              const s = (report.stats[key] ??= {});
              for (const k of ["minText", "minBoundary", "minFocus"]) {
                if (stats[k] && (!s[k] || stats[k].ratio < s[k].ratio)) s[k] = { ...stats[k], at: name };
              }
            } else {
              await page.evaluate(() => window.styleRenders.blur());
            }
            await page.screenshot({ path: join(dir, `${safe(name)}.png`), fullPage: false });
            count++;
          }
        }
        report.counts[`${skin}/${palette}`] = count;
        if (problems.length) {
          console.log(`page errors in ${skin}/${palette}: ${problems.slice(0, 3).join(" | ")}`);
          failed += 1;
        }
        await context.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
  if (checksOn) {
    const kinds = {};
    for (const list of Object.values(report.failures)) for (const f of list) kinds[f.kind] = (kinds[f.kind] ?? 0) + 1;
    report.byKind = kinds;
    report.total = failed;
    writeFileSync(join(out, "checks.json"), JSON.stringify(report, null, 1) + "\n", "utf8");
    console.log("pictures:", JSON.stringify(report.counts));
    console.log("failures by kind:", JSON.stringify(kinds), "total", failed);
    for (const [k, v] of Object.entries(report.stats)) {
      const f = (x) => (x ? `${x.ratio.toFixed(2)} (${x.at}: ${x.where})` : "n/a");
      console.log(`lowest ${k}: text ${f(v.minText)}; boundary ${f(v.minBoundary)}; focus ${f(v.minFocus)}`);
    }
  }
  return failed;
}

function walk(dir, rel = "") {
  const out = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...walk(dir, join(rel, e.name)));
    else if (e.name.endsWith(".png")) out.push(join(rel, e.name));
  }
  return out;
}

async function compose(before, after, out) {
  const browser = await chromium.launch();
  let n = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 600 }, deviceScaleFactor: 1 });
    for (const rel of walk(after)) {
      if (!existsSync(join(before, rel))) continue;
      const [skin, palette, file] = rel.split(/[\\/]/);
      const [view, ...state] = file.replace(/\.png$/, "").split("-");
      const b64 = (p) => readFileSync(p).toString("base64");
      const dark = palette === "dark";
      await page.setContent(`<body style="margin:0;padding:12px;background:${dark ? "#111" : "#e8e8e8"};color:${dark ? "#eee" : "#111"};font:14px system-ui;width:max-content">
        <div style="margin-bottom:8px">${view} / ${state.join("-")} / ${palette} / ${skin}&nbsp;&nbsp;&nbsp;(before | after)</div>
        <div style="display:flex;gap:16px;align-items:flex-start">
          <img style="width:380px" src="data:image/png;base64,${b64(join(before, rel))}">
          <img style="width:380px" src="data:image/png;base64,${b64(join(after, rel))}">
        </div></body>`);
      await page.waitForFunction(() => [...document.images].every((i) => i.complete));
      const target = join(out, rel);
      mkdirSync(dirname(target), { recursive: true });
      await page.locator("body").screenshot({ path: target });
      n++;
    }
  } finally {
    await browser.close();
  }
  console.log(`composed ${n} pictures into ${out}`);
}

const [mode, a, b, c] = process.argv.slice(2);
try {
  if (mode === "render" && a) process.exitCode = (await render(resolve(a))) > 0 ? 1 : 0;
  else if (mode === "compose" && a && b && c) await compose(resolve(a), resolve(b), resolve(c));
  else {
    console.log("usage: render.mjs render <outDir> [--skin s] [--palette p] [--only view[:state]] [--no-checks] | compose <before> <after> <out>");
    process.exitCode = 2;
  }
} catch (e) {
  console.error(e);
  process.exitCode = 1;
}
