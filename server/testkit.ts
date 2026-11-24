import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { ListInputSchema, type ListInput } from "../shared/schema";
import { rootId, type AgentRoot } from "./roots";
import { SessionManager, type ManagerOptions } from "./service";

/**
 * Test fixtures: an isolated fake host with Claude Code, Codex, and Antigravity directories,
 * a Paseo home, and a source tree, all under a fresh temporary directory. Only synthetic data.
 */

export interface FakeHost {
  base: string;
  claude: string;
  codex: string;
  antigravity: string;
  paseo: string;
  trash: string;
  source: string;
  root: AgentRoot;
  codexRoot: AgentRoot;
  antigravityRoot: AgentRoot;
  roots: AgentRoot[];
  cleanup(): Promise<void>;
}

export async function makeHost(name = "host"): Promise<FakeHost> {
  const base = await realpath(await mkdtemp(join(tmpdir(), `sm-${name}-`)));
  const claude = join(base, "claude");
  const codex = join(base, "codex");
  const antigravity = join(base, "antigravity-cli");
  const paseo = join(base, "paseo");
  const source = join(base, "src", "app");
  await mkdir(join(claude, "projects"), { recursive: true });
  await mkdir(join(codex, "sessions"), { recursive: true });
  await mkdir(join(antigravity, "conversations"), { recursive: true });
  await mkdir(join(antigravity, "brain"), { recursive: true });
  await mkdir(paseo, { recursive: true });
  await mkdir(source, { recursive: true });
  const root: AgentRoot = { id: rootId(claude, "claude"), provider: "claude", path: claude, real: claude, isDefault: true, source: "default", available: true };
  const codexRoot: AgentRoot = { id: rootId(codex, "codex"), provider: "codex", path: codex, real: codex, isDefault: true, source: "default", available: true };
  const antigravityRoot: AgentRoot = {
    id: rootId(antigravity, "antigravity"),
    provider: "antigravity",
    path: antigravity,
    real: antigravity,
    isDefault: true,
    source: "default",
    available: true,
  };
  return {
    base,
    claude,
    codex,
    antigravity,
    paseo,
    source,
    trash: join(paseo, "plugin-data", "session-manager", "trash"),
    root,
    codexRoot,
    antigravityRoot,
    roots: [root, codexRoot, antigravityRoot],
    cleanup: () => rm(base, { recursive: true, force: true }),
  };
}

export function manager(host: FakeHost, options: Partial<ManagerOptions> = {}): SessionManager {
  return new SessionManager({
    roots: async () => host.roots,
    paseoHome: host.paseo,
    trashDir: host.trash,
    alive: () => false,
    recentMs: 0,
    ...options,
  });
}

export function query(input: ListInput = {}) {
  return ListInputSchema.parse(input);
}

let clock = Date.parse("2026-01-01T00:00:00.000Z");
export function nextTime(): string {
  clock += 1000;
  return new Date(clock).toISOString();
}

export function user(sessionId: string, text: string | unknown[], extra: Record<string, unknown> = {}) {
  return {
    type: "user",
    uuid: randomUUID(),
    parentUuid: null,
    sessionId,
    cwd: "/work/app",
    gitBranch: "main",
    version: "2.1.0",
    timestamp: nextTime(),
    isSidechain: false,
    message: { role: "user", content: text },
    ...extra,
  };
}

export function assistant(sessionId: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    uuid: randomUUID(),
    parentUuid: null,
    sessionId,
    cwd: "/work/app",
    timestamp: nextTime(),
    isSidechain: false,
    message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }] },
    ...extra,
  };
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

/** A Claude conversation with a subagent directory, tool results, and every per-session artifact. */
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

/** A Codex rollout with capabilities and shell snapshot artifacts. */
export async function writeFullCodexSession(
  host: FakeHost,
  options: { sessionId?: string; cwd?: string; prompt?: string; reply?: string; dateDir?: string; title?: string; branch?: string } = {},
): Promise<{ sessionId: string; relDir: string; rolloutPath: string }> {
  const sessionId = options.sessionId ?? randomUUID();
  const cwd = options.cwd ?? "/work/app";
  const dateDir = options.dateDir ?? "sessions/2026/11/24";
  const rolloutPath = join(host.codex, dateDir, `rollout-2026-11-24T04-06-51-${sessionId}.jsonl`);
  const records = [
    {
      timestamp: nextTime(),
      type: "session_meta",
      payload: { id: sessionId, session_id: sessionId, cwd, cli_version: "0.172.0", git: { branch: options.branch ?? "feat/codex" } },
    },
    { timestamp: nextTime(), type: "turn_context", payload: { cwd, model: "gpt-5.3-codex" } },
    {
      timestamp: nextTime(),
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "<environment_context>ignored</environment_context>" }] },
    },
    {
      timestamp: nextTime(),
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: options.prompt ?? "Optimize the cache layer" }] },
    },
    {
      timestamp: nextTime(),
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: options.reply ?? "Added LRU eviction to the cache." }] },
    },
  ];
  await writeFileDeep(rolloutPath, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
  await writeFileDeep(join(host.codex, "tui-thread-reference-capabilities", sessionId), "");
  await writeFileDeep(join(host.codex, "shell_snapshots", `${sessionId}.12345.sh`), "export PATH=/usr/bin\n");
  if (options.title) {
    await writeFileDeep(join(host.codex, "session_index.jsonl"), `${JSON.stringify({ id: sessionId, thread_name: options.title, updated_at: nextTime() })}\n`);
  }
  return { sessionId, relDir: dateDir, rolloutPath };
}

/** An Antigravity conversation with .db, brain transcript, annotation, presence, and cache metadata. */
export async function writeFullAntigravitySession(
  host: FakeHost,
  options: { sessionId?: string; cwd?: string; title?: string; prompt?: string; reply?: string } = {},
): Promise<string> {
  const sessionId = options.sessionId ?? randomUUID();
  const cwd = options.cwd ?? "/work/app";
  const title = options.title ?? "Refactor telemetry pipeline";
  await writeFileDeep(join(host.antigravity, "conversations", `${sessionId}.db`), "synthetic-db-bytes");
  const txPath = join(host.antigravity, "brain", sessionId, ".system_generated", "logs", "transcript.jsonl");
  const lines = [
    {
      step_index: 0,
      source: "USER_EXPLICIT",
      type: "USER_INPUT",
      status: "DONE",
      created_at: nextTime(),
      content: `<USER_REQUEST>\n${options.prompt ?? "Refactor the telemetry pipeline for lower latency"}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nlocal\n</ADDITIONAL_METADATA>`,
    },
    {
      step_index: 1,
      source: "MODEL",
      type: "PLANNER_RESPONSE",
      status: "DONE",
      created_at: nextTime(),
      model: "gemini-4-neon-high",
      thinking: "internal reasoning not shown",
      tool_calls: [{ name: "invoke_subagent" }],
      content: options.reply ?? "Refactored telemetry batching with ring buffer.",
    },
  ];
  await writeFileDeep(txPath, `${lines.map((r) => JSON.stringify(r)).join("\n")}\n`);
  await writeFileDeep(join(host.antigravity, "annotations", `${sessionId}.pbtxt`), "last_viewed: 1\n");
  await writeFileDeep(join(host.antigravity, "presence", `${sessionId}.lock`), "");

  const metaPath = join(host.antigravity, "cache", "conversation_metadata.json");
  let existingMeta: { conversations: Record<string, unknown> } = { conversations: {} };
  try {
    existingMeta = JSON.parse(await readFile(metaPath, "utf8")) as { conversations: Record<string, unknown> };
  } catch {
    // First entry.
  }
  existingMeta.conversations[sessionId] = {
    summary: {
      ID: sessionId,
      Title: title,
      Preview: title,
      NumSteps: 2,
      UpdatedAt: nextTime(),
      WorkspaceURIs: [pathToFileURL(cwd).href],
      ProjectID: "default-cli-project",
    },
  };
  await writeFileDeep(metaPath, `${JSON.stringify(existingMeta, null, 2)}\n`);
  await writeFileDeep(join(host.antigravity, "cache", "last_conversations.json"), `${JSON.stringify({ [cwd]: sessionId }, null, 2)}\n`);
  return sessionId;
}

/** Files across all three providers that must never change: config, credentials, skills, shared DBs, and source. */
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
    join(host.codex, "auth.json"),
    join(host.codex, "config.toml"),
    join(host.codex, "history.jsonl"),
    join(host.codex, "state_5.sqlite"),
    join(host.codex, "skills", "custom", "SKILL.md"),
    join(host.antigravity, "settings.json"),
    join(host.antigravity, "history.jsonl"),
    join(host.antigravity, "conversation_summaries.db"),
    join(host.antigravity, "cache", "acp-auth-state.json"),
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
