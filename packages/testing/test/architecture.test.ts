import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const packagesDir = join(root, "packages");

/**
 * Which `@fadenstack/*` packages each package may use (sdk/52 §4 and §6).
 * A package that exists in `packages/` but has no row here fails T1.
 */
const LAYERS: Record<string, readonly string[]> = {
  // layer 1
  client: [],
  // layer 2
  agents: ["client"],
  // layer 3, the modules (never ui, ui-web, a skin, or another module)
  provenance: ["agents", "client"],
  skills: ["agents", "client"],
  mcp: ["agents", "client"],
  "web-search": ["agents", "client"],
  // layer 4
  ui: ["agents", "client"],
  "ui-web": ["ui", "agents", "client"],
  // layer 5, the skins (never a module package directly)
  "ui-react": ["ui", "ui-web", "agents", "client"],
  "ui-vue": ["ui", "ui-web", "agents", "client"],
  // test helpers
  testing: ["client", "agents", "provenance"],
};
const MODULES = ["provenance", "skills", "mcp", "web-search"];

const BROWSER_IDENTIFIERS = new Set([
  "window",
  "document",
  "navigator",
  "localStorage",
  "sessionStorage",
  "location",
  "history",
  "alert",
  "confirm",
  "prompt",
  "open",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "getComputedStyle",
  "matchMedia",
]);
const GLOBAL_OBJECTS = new Set(["globalThis", "self", "window"]);
const DOM_TYPES = new Set([
  "HTMLElement",
  "Element",
  "Document",
  "Window",
  "DOMParser",
  "MutationObserver",
  "ResizeObserver",
  "IntersectionObserver",
  "KeyboardEvent",
  "MouseEvent",
  "PointerEvent",
  "ClipboardEvent",
  "DragEvent",
  "FocusEvent",
  "InputEvent",
  "CSSStyleDeclaration",
  "ShadowRoot",
]);
const isDomType = (name: string): boolean => DOM_TYPES.has(name) || /^HTML\w*Element$/.test(name);
const VISIBLE_ATTRIBUTES = new Set(["title", "aria-label", "alt", "placeholder", "aria-description"]);

interface Finding {
  /** The finding without a line number; what the allow-list matches. */
  key: string;
  /** The finding as reported, with the line number where there is one. */
  shown: string;
}
type Allowlist = Record<"T1" | "T2" | "T3" | "T4", { finding: string; reason: string }[]>;

const allowlist = JSON.parse(
  readFileSync(fileURLToPath(new URL("./architecture-allowlist.json", import.meta.url)), "utf8"),
) as Allowlist;

const rel = (file: string): string => relative(root, file).split("\\").join("/");

function packageNames(): string[] {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(packagesDir, entry.name, "package.json")))
    .map((entry) => entry.name);
}

function walk(dir: string, found: string[] = []): string[] {
  if (!existsSync(dir)) return found;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, found);
    else found.push(path);
  }
  return found;
}

/** The source files of `packages/<pkg>/src` with one of the given extensions. */
function srcFiles(pkg: string, extensions: readonly string[]): string[] {
  return walk(join(packagesDir, pkg, "src"))
    .filter((file) => extensions.some((ext) => file.endsWith(ext)))
    .sort();
}

interface Script {
  file: string;
  text: string;
  /** Offset of `text` in the file, for line numbers. */
  offset: number;
  tsx: boolean;
}

/** The TypeScript the file holds: the file itself, or the script blocks of a .vue file. */
function scripts(file: string): Script[] {
  const text = readFileSync(file, "utf8");
  if (!file.endsWith(".vue")) return [{ file, text, offset: 0, tsx: file.endsWith(".tsx") }];
  const found: Script[] = [];
  for (const match of text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    found.push({ file, text: match[1] ?? "", offset: match.index + match[0].indexOf(">") + 1, tsx: false });
  }
  return found;
}

function parse(script: Script): ts.SourceFile {
  return ts.createSourceFile(
    script.file,
    script.text,
    ts.ScriptTarget.Latest,
    true,
    script.tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

function visit(node: ts.Node, fn: (node: ts.Node) => void): void {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

function line(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** Module specifiers: imports, export-from, import("..."), import x = require("..."), import("...") types. */
function specifiers(sf: ts.SourceFile): string[] {
  const found: string[] = [];
  visit(sf, (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteral(node.moduleSpecifier)) found.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [arg] = node.arguments;
      if (arg && ts.isStringLiteralLike(arg)) found.push(arg.text);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expr = node.moduleReference.expression;
      if (ts.isStringLiteralLike(expr)) found.push(expr.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      if (ts.isStringLiteral(node.argument.literal)) found.push(node.argument.literal.text);
    }
  });
  return found;
}

/** Applies the allow-list: the findings it does not cover, and the entries that cover none. */
function judge(test: keyof Allowlist, findings: Finding[]) {
  const entries = allowlist[test];
  const allowed = new Set(entries.map((entry) => entry.finding));
  const keys = new Set(findings.map((finding) => finding.key));
  return {
    findings: [...new Set(findings.filter((f) => !allowed.has(f.key)).map((f) => f.shown))].sort(),
    "stale allow-list entries": entries.map((e) => e.finding).filter((finding) => !keys.has(finding)),
  };
}

describe("the architecture of the packages", () => {
  it("has a layer rule for every package and keeps each package's dependencies inside its layer (T1)", () => {
    const findings: Finding[] = [];
    for (const dir of packageNames()) {
      const manifest = JSON.parse(readFileSync(join(packagesDir, dir, "package.json"), "utf8")) as {
        name: string;
        dependencies?: Record<string, string>;
        peerDependencies?: Record<string, string>;
      };
      const row = LAYERS[dir];
      if (!row) {
        findings.push({ key: `${manifest.name} -> (no layer rule)`, shown: `${manifest.name} -> (no layer rule)` });
        continue;
      }
      const declared = [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.peerDependencies ?? {})];
      for (const dependency of declared) {
        if (!dependency.startsWith("@fadenstack/")) continue;
        if (!row.includes(dependency.slice("@fadenstack/".length))) {
          const finding = `${manifest.name} -> ${dependency}`;
          findings.push({ key: finding, shown: finding });
        }
      }
    }
    expect(judge("T1", findings)).toEqual({ findings: [], "stale allow-list entries": [] });
  });

  it("imports only what the package's layer allows, and each framework only in its skin (T2)", () => {
    const findings: Finding[] = [];
    for (const pkg of packageNames()) {
      const row = LAYERS[pkg];
      if (!row) continue; // T1 reports a package without a rule
      for (const file of srcFiles(pkg, [".ts", ".tsx", ".vue"])) {
        for (const script of scripts(file)) {
          for (const specifier of specifiers(parse(script))) {
            const scoped = /^@fadenstack\/([^/]+)/.exec(specifier);
            const bad =
              (scoped?.[1] !== undefined && scoped[1] !== pkg && !row.includes(scoped[1])) ||
              (/^react(-dom)?(\/|$)/.test(specifier) && pkg !== "ui-react") ||
              (/^vue(\/|$)/.test(specifier) && pkg !== "ui-vue");
            if (bad) {
              const finding = `${rel(file)}: ${specifier}`;
              findings.push({ key: finding, shown: finding });
            }
          }
        }
      }
    }
    expect(judge("T2", findings)).toEqual({ findings: [], "stale allow-list entries": [] });
  });

  it("keeps browser APIs out of the ui package and the modules (T3)", () => {
    const findings: Finding[] = [];
    for (const pkg of ["ui", ...MODULES]) {
      for (const file of srcFiles(pkg, [".ts", ".tsx"])) {
        for (const script of scripts(file)) {
          const sf = parse(script);
          const declared = new Set<string>();
          visit(sf, (node) => {
            const named =
              ts.isVariableDeclaration(node) ||
              ts.isFunctionDeclaration(node) ||
              ts.isClassDeclaration(node) ||
              ts.isParameter(node) ||
              ts.isBindingElement(node) ||
              ts.isImportClause(node) ||
              ts.isImportSpecifier(node) ||
              ts.isNamespaceImport(node) ||
              ts.isImportEqualsDeclaration(node) ||
              ts.isEnumDeclaration(node) ||
              ts.isInterfaceDeclaration(node) ||
              ts.isTypeAliasDeclaration(node) ||
              ts.isTypeParameterDeclaration(node) ||
              ts.isModuleDeclaration(node);
            if (named && node.name && ts.isIdentifier(node.name)) declared.add(node.name.text);
          });
          const report = (node: ts.Node, what: string) => {
            const finding = `${rel(file)}: ${what}`;
            findings.push({ key: finding, shown: `${rel(file)}:${line(sf, node)}: ${what}` });
          };
          visit(sf, (node) => {
            // property access on a global object: globalThis.open
            if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
              // through casts and brackets: `(globalThis as { localStorage?: Storage }).localStorage` reads it too
              let target: ts.Expression = node.expression;
              while (
                ts.isParenthesizedExpression(target) ||
                ts.isAsExpression(target) ||
                ts.isTypeAssertionExpression(target) ||
                ts.isNonNullExpression(target) ||
                ts.isSatisfiesExpression(target)
              ) {
                target = target.expression;
              }
              const member = ts.isPropertyAccessExpression(node)
                ? node.name.text
                : ts.isStringLiteralLike(node.argumentExpression)
                  ? node.argumentExpression.text
                  : undefined;
              if (
                ts.isIdentifier(target) &&
                GLOBAL_OBJECTS.has(target.text) &&
                !declared.has(target.text) &&
                member !== undefined &&
                BROWSER_IDENTIFIERS.has(member)
              ) {
                report(node, `${target.text}.${member}`);
              }
              return;
            }
            if (!ts.isIdentifier(node)) return;
            const parent = node.parent;
            // a DOM type used as a type (or in `extends`)
            if (
              (ts.isTypeReferenceNode(parent) && parent.typeName === node) ||
              (ts.isExpressionWithTypeArguments(parent) && parent.expression === node)
            ) {
              if (isDomType(node.text) && !declared.has(node.text)) report(node, `type ${node.text}`);
              return;
            }
            if (!BROWSER_IDENTIFIERS.has(node.text) || declared.has(node.text)) return;
            // not a reference: the name after a dot, a declaration's own name, a property name
            const record = parent as unknown as { name?: ts.Node; propertyName?: ts.Node };
            if (ts.isShorthandPropertyAssignment(parent)) {
              /* `{ document }` reads the variable */
            } else if (record.name === node || record.propertyName === node) {
              return;
            }
            if (ts.isQualifiedName(parent) && parent.right === node) return;
            // `window.open` is reported as the property access
            if (
              ts.isPropertyAccessExpression(parent) &&
              parent.expression === node &&
              BROWSER_IDENTIFIERS.has(parent.name.text)
            ) {
              return;
            }
            report(node, node.text);
          });
        }
      }
    }
    expect(judge("T3", findings)).toEqual({ findings: [], "stale allow-list entries": [] });
  });

  it("keeps literal text out of the React and Vue skins (T4)", () => {
    const findings: Finding[] = [];
    const add = (file: string, lineNumber: number, text: string) => {
      const shown = text.replace(/\s+/g, " ").trim();
      findings.push({ key: `${rel(file)}: ${shown}`, shown: `${rel(file)}:${lineNumber}: ${shown}` });
    };

    for (const file of srcFiles("ui-react", [".tsx"])) {
      const script = scripts(file)[0];
      if (!script) continue;
      const sf = parse(script);
      visit(sf, (node) => {
        if (ts.isJsxText(node)) {
          if (!/\p{L}/u.test(node.text)) return;
          const lead = node.text.length - node.text.trimStart().length;
          add(file, line(sf, node) + (node.text.slice(0, lead).match(/\n/g)?.length ?? 0), node.text);
        } else if (ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && VISIBLE_ATTRIBUTES.has(node.name.text)) {
          let value: ts.Node | undefined = node.initializer;
          if (value && ts.isJsxExpression(value)) value = value.expression;
          if (value && ts.isStringLiteralLike(value) && value.text.trim() !== "") {
            add(file, line(sf, value), value.text);
          }
        }
      });
    }

    for (const file of srcFiles("ui-vue", [".vue"])) {
      const text = readFileSync(file, "utf8");
      const open = /^<template\b[^>]*>/m.exec(text);
      const closes = [...text.matchAll(/^<\/template>/gm)];
      const close = closes[closes.length - 1];
      if (!open || !close) continue;
      const start = open.index + open[0].length;
      const body = text.slice(start, close.index);
      const at = (offset: number) => lineOf(text, start + offset);

      let i = 0;
      while (i < body.length) {
        if (body.startsWith("<!--", i)) {
          const end = body.indexOf("-->", i);
          i = end < 0 ? body.length : end + 3;
        } else if (body[i] === "<" && /[A-Za-z/]/.test(body[i + 1] ?? "")) {
          let j = i + 1;
          let quote = "";
          for (; j < body.length; j++) {
            const ch = body[j];
            if (quote) {
              if (ch === quote) quote = "";
            } else if (ch === '"' || ch === "'") quote = ch;
            else if (ch === ">") break;
          }
          const tag = body.slice(i, j);
          if (body[i + 1] !== "/") {
            const attrs = tag.replace(/^<[^\s/>]+/, "");
            const pattern = /([^\s=/>"']+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
            for (const m of attrs.matchAll(pattern)) {
              const value = m[2] ?? m[3] ?? m[4] ?? "";
              if (VISIBLE_ATTRIBUTES.has(m[1] ?? "") && value.trim() !== "") {
                add(file, at(i + tag.indexOf(m[0])), value);
              }
            }
          }
          i = j + 1;
        } else {
          let j = i;
          while (j < body.length) {
            if (body.startsWith("{{", j)) {
              const end = body.indexOf("}}", j);
              j = end < 0 ? body.length : end + 2;
            } else if (body[j] === "<" && /[A-Za-z/!]/.test(body[j + 1] ?? "")) break;
            else j++;
          }
          const chunk = body.slice(i, j);
          const words = chunk.replace(/\{\{[\s\S]*?\}\}/g, " ").replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, " ");
          if (/\p{L}/u.test(words)) {
            const lead = chunk.length - chunk.trimStart().length;
            add(file, at(i + lead), chunk.replace(/\{\{[\s\S]*?\}\}/g, " "));
          }
          i = Math.max(j, i + 1);
        }
      }
    }
    expect(judge("T4", findings)).toEqual({ findings: [], "stale allow-list entries": [] });
  });
});
