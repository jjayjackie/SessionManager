// Bundles both entries the way Paseo does (esbuild, host modules external) to catch unresolved
// imports and runtime-boundary mistakes that a typecheck cannot see. Output is discarded.
import { build } from "esbuild";

const shared = { bundle: true, write: false, logLevel: "warning", absWorkingDir: new URL("..", import.meta.url).pathname, loader: { ".json": "json", ".svg": "text" } };
const client = await build({
  ...shared,
  entryPoints: ["index.client.tsx"],
  platform: "neutral",
  format: "esm",
  jsx: "automatic",
  mainFields: ["module", "main"],
  external: ["react", "react/jsx-runtime", "react-native", "@tanstack/react-query", "zod", "@getpaseo/plugin", "@getpaseo/plugin/*"],
});
const server = await build({
  ...shared,
  entryPoints: ["index.server.ts"],
  platform: "node",
  format: "esm",
  external: ["zod", "@getpaseo/plugin", "@getpaseo/plugin/*"],
});
const size = (result) => result.outputFiles.reduce((sum, file) => sum + file.contents.length, 0);
const clientCode = client.outputFiles.map((file) => file.text).join("\n");
if (/from\s*["']node:|require\(["']node:/.test(clientCode)) {
  console.error("Client bundle references a Node module.");
  process.exit(1);
}
console.log(`Bundles OK: client ${size(client)} bytes, server ${size(server)} bytes.`);
