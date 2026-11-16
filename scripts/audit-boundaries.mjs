// Static checks for Paseo's runtime boundaries, cross-platform UI rules, and leaked data.
// Runs in CI only. Exits non-zero with a list of findings.
import { readdir, readFile, stat } from "node:fs/promises";
import { builtinModules } from "node:module";
import { join, relative, sep } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const findings = [];
const nodeModules = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);

async function walk(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, files);
    else files.push(path);
  }
  return files;
}

const files = await walk(root);
const rel = (path) => relative(root, path).split(sep).join("/");
const importsOf = (source) => [...source.matchAll(/(?:import|export)\s[^"']*?from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1] ?? m[2]);

for (const path of files) {
  const name = rel(path);
  const isCode = /\.(ts|tsx|mjs|js)$/.test(name);
  const source = isCode || /\.(json|md|yml|yaml)$/.test(name) ? await readFile(path, "utf8") : "";
  const area = name.startsWith("client/") || name === "index.client.tsx" ? "client" : name.startsWith("server/") || name === "index.server.ts" ? "server" : name.startsWith("shared/") ? "shared" : "other";

  if (isCode && area !== "other") {
    for (const specifier of importsOf(source)) {
      if (area !== "server" && nodeModules.has(specifier)) findings.push(`${name}: Node module "${specifier}" in ${area} code`);
      if (area !== "server" && /(^|\/)server(\/|$)/.test(specifier) && specifier.startsWith(".")) findings.push(`${name}: imports server code`);
      if (area !== "client" && /(^|\/)client(\/|$)/.test(specifier) && specifier.startsWith(".")) findings.push(`${name}: imports client code`);
      if (area === "server" && /^(react|react-native|@tanstack\/react-query)$|^@getpaseo\/plugin\/client/.test(specifier)) findings.push(`${name}: client module "${specifier}" in server code`);
      if (area === "shared" && /^(react|react-native)$|^@getpaseo\/plugin\/(client|server)/.test(specifier)) findings.push(`${name}: runtime-specific module "${specifier}" in shared code`);
    }
  }
  if (area === "client" && isCode && !name.endsWith("client/web.ts")) {
    const dom = source.match(/\b(document|window|localStorage|sessionStorage|navigator)\.|\bonClick=|\bclassName=|<(div|span|button|input|a|p)[\s>]/);
    if (dom) findings.push(`${name}: DOM API or HTML element "${dom[0]}" outside client/web.ts`);
    const color = source.match(/["'](#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))["']/);
    if (color) findings.push(`${name}: hardcoded color ${color[1]}; use theme.colors`);
  }
  // Secrets and real session data must never be committed.
  if (/(sk-ant-[A-Za-z0-9_-]{10,}|github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/.test(source)) findings.push(`${name}: looks like a secret`);
  if (/\.jsonl$/.test(name) || /(^|\/)\.credentials\.json$/.test(name)) findings.push(`${name}: transcript or credential file in the repository`);
  if ((await stat(path)).size > 512 * 1024) findings.push(`${name}: unexpectedly large file`);
}

const required = ["paseo-plugin.json", "index.client.tsx", "index.server.ts", "LICENSE", "README.md", "OVERVIEW.md"];
for (const file of required) if (!files.some((path) => rel(path) === file)) findings.push(`missing ${file}`);
const rootCode = files.filter((path) => !rel(path).includes("/") && /\.(ts|tsx)$/.test(path) && !/^index\.(client|server)\.tsx?$/.test(rel(path)));
for (const path of rootCode) findings.push(`${rel(path)}: code modules belong in client/, server/, or shared/`);

if (findings.length) {
  console.error(`Boundary and safety audit failed:\n${findings.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(`Boundary and safety audit passed (${files.length} files).`);
