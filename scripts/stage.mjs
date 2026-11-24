// Stages the installable plugin (no tests, scripts, or tooling) into dist/session-manager.
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const target = join(root, "dist", "session-manager");
await rm(join(root, "dist"), { recursive: true, force: true });
await mkdir(target, { recursive: true });
const include = ["paseo-plugin.json", "package.json", "tsconfig.json", "tsconfig.server.json", "index.client.tsx", "index.server.ts", "README.md", "README.zh-CN.md", "assets", "OVERVIEW.md", "OVERVIEW.zh-CN.md", "LICENSE", "client", "server", "shared"];
for (const entry of include) {
  await cp(join(root, entry), join(target, entry), {
    recursive: true,
    filter: (source) => !/\.test\.ts$/.test(source) && !source.endsWith("testkit.ts"),
  });
}
const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
console.log(`Staged session-manager ${version} in dist/`);
