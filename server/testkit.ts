import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { ListInputSchema, type ListInput } from "../shared/schema";
import { rootId, type ClaudeRoot } from "./roots";
import { SessionManager, type ManagerOptions } from "./service";

/**
 * Test fixtures: an isolated fake host with a Claude directory, a Paseo home, and a source tree,
 * all under a fresh temporary directory. Only synthetic data is written.
 */

export interface FakeHost {
  base: string;
  claude: string;
  paseo: string;
  trash: string;
  source: string;
  root: ClaudeRoot;
  cleanup(): Promise<void>;
}

export async function makeHost(name = "host"): Promise<FakeHost> {
  const base = await realpath(await mkdtemp(join(tmpdir(), `csm-${name}-`)));
  const claude = join(base, "claude");
  const paseo = join(base, "paseo");
  const source = join(base, "src", "app");
  await mkdir(join(claude, "projects"), { recursive: true });
  await mkdir(paseo, { recursive: true });
  await mkdir(source, { recursive: true });
  return {
    base, claude, paseo, source, trash: join(paseo, "plugin-data", "claude-session-manager", "trash"),
    root: { id: rootId(claude), path: claude, real: claude, isDefault: true, source: "default", available: true },
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

export function manager(host: FakeHost, options: Partial<ManagerOptions> = {}): SessionManager {
  return new SessionManager({ roots: async () => [host.root], paseoHome: host.paseo, trashDir: host.trash, alive: () => false, recentMs: 0, ...options });
}

export function query(input: ListInput = {}) {
  return ListInputSchema.parse(input);
}

let clock = Date.parse("2026-01-01T00:00:00.000Z");
function nextTime(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

export function user(sessionId: string, text: string | unknown[], extra: Record<string, unknown> = {}) {
  return { type: "user", uuid: randomUUID(), parentUuid: null, sessionId, cwd: "/work/app", gitBranch: "main", version: "2.1.0", timestamp: nextTime(), isSidechain: false, message: { role: "user", content: text }, ...extra };
}

export function assistant(sessionId: string, text: string, extra: Record<string, unknown> = {}) {
  return { type: "assistant", uuid: randomUUID(), parentUuid: null, sessionId, cwd: "/work/app", timestamp: nextTime(), isSidechain: false, message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }] }, ...extra };
}

export function encodeProject(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export async function writeFileDeep(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

export async function writeTranscript(host: FakeHost, projectDir: string, sessionId: string, records: (object | string)[]): Promise<string> {
  const path = join(host.claude, "projects", projectDir, `${sessionId}.jsonl`);
  await writeFileDeep(path, `${records.map((record) => (typeof record === "string" ? record : JSON.stringify(record))).join("\n")}\n`);
  return path;
}

/** A conversation with a subagent directory, tool results, and every per-session artifact. */
export async function writeFullSession(host: FakeHost, projectDir: string, sessionId = randomUUID(), title = "Fix the login bug"): Promise<string> {
  await writeTranscript(host, projectDir, sessionId, [
    { type: "custom-title", customTitle: title, sessionId },
    user(sessionId, "Please fix the login bug in auth.ts"),
    assistant(sessionId, "I found the problem in the token refresh logic."),
  ]);
  const dir = join(host.claude, "projects", projectDir, sessionId);
  await writeFileDeep(join(dir, "subagents", "agent-a1.jsonl"), `${JSON.stringify(user(sessionId, "subtask", { isSidechain: true }))}\n`);
  await writeFileDeep(join(dir, "tool-results", "r1.txt"), "tool output");
  await writeFileDeep(join(host.claude, "todos", `${sessionId}-agent-${sessionId}.json`), "[]");
  await writeFileDeep(join(host.claude, "file-history", sessionId, "abc@v1"), "backup");
  await writeFileDeep(join(host.claude, "session-env", sessionId, "env.sh"), "export A=1");
  await writeFileDeep(join(host.claude, "debug", `${sessionId}.txt`), "debug log");
  return sessionId;
}

/** Files that must never change: configuration, credentials, memory, skills, and source. */
export async function writeSentinels(host: FakeHost, projectDir: string): Promise<string[]> {
  const files = [
    join(host.claude, "settings.json"),
    join(host.claude, "settings.local.json"),
    join(host.claude, ".credentials.json"),
    join(host.claude, "history.jsonl"),
    join(host.claude, "CLAUDE.md"),
    join(host.claude, "skills", "review", "SKILL.md"),
    join(host.claude, "plugins", "installed_plugins.json"),
    join(host.claude, "agents", "helper.md"),
    join(host.claude, "commands", "ship.md"),
    join(host.claude, "projects", projectDir, "memory", "MEMORY.md"),
    join(host.base, "claude.json"),
    join(host.base, ".mcp.json"),
    join(host.source, "index.ts"),
    join(host.paseo, "config.json"),
  ];
  for (const file of files) await writeFileDeep(file, `sentinel ${relative(host.base, file)}\n`);
  return files;
}

export async function digest(paths: string[]): Promise<string> {
  const hash = createHash("sha256");
  for (const path of paths) hash.update(path).update(await readFile(path));
  return hash.digest("hex");
}

/** Every file under a directory, relative, with content hashes; for byte-identical restore checks. */
export async function tree(directory: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const walk = async (path: string) => {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) result.set(relative(directory, child), createHash("sha256").update(await readFile(child)).digest("hex"));
    }
  };
  await walk(directory);
  return result;
}

export async function age(path: string, seconds = 3600): Promise<void> {
  const time = new Date(Date.now() - seconds * 1000);
  await utimes(path, time, time);
}
