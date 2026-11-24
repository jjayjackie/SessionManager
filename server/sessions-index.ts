import { randomBytes } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Keeps provider-native session indexes synchronized with deletes and restores:
 * - Claude Code:  `projects/<dir>/sessions-index.json` (`{ entries: [{ sessionId, ... }] }`)
 * - Codex:        `<root>/session_index.jsonl` (JSONL with `{ id, ... }`)
 * - Antigravity:  `<root>/cache/conversation_metadata.json` (`{ conversations: { [id]: ... } }`)
 *                 and `<root>/cache/last_conversations.json` (`{ [cwd]: id }`)
 *
 * Unknown fields are preserved. Malformed files are left untouched.
 */

export const SESSIONS_INDEX = "sessions-index.json";
export const CODEX_SESSION_INDEX = "session_index.jsonl";

export type IndexStatus = "absent" | "unchanged" | "updated" | "invalid";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readJsonFile(path: string): Promise<{ data: Record<string, unknown> } | "absent" | "invalid"> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) return "invalid";
  } catch {
    return "absent";
  }
  try {
    const data: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(data)) return "invalid";
    return { data };
  } catch {
    return "invalid";
  }
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const temporary = `${path}.sm-${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Claude Code: projects/<dir>/sessions-index.json
// ---------------------------------------------------------------------------

async function readClaudeIndex(projectPath: string): Promise<{ data: Record<string, unknown>; entries: unknown[] } | "absent" | "invalid"> {
  const result = await readJsonFile(join(projectPath, SESSIONS_INDEX));
  if (result === "absent" || result === "invalid") return result;
  if (!Array.isArray(result.data.entries)) return "invalid";
  return { data: result.data, entries: result.data.entries };
}

function entrySessionId(entry: unknown): string {
  return isRecord(entry) && typeof entry.sessionId === "string" ? entry.sessionId : "";
}

export async function removeFromIndex(projectPath: string, sessionId: string): Promise<{ status: IndexStatus; removed: unknown[] }> {
  const index = await readClaudeIndex(projectPath);
  if (index === "absent" || index === "invalid") return { status: index, removed: [] };
  const removed = index.entries.filter((entry) => entrySessionId(entry) === sessionId);
  if (!removed.length) return { status: "unchanged", removed };
  const kept = index.entries.filter((entry) => entrySessionId(entry) !== sessionId);
  await writeAtomically(join(projectPath, SESSIONS_INDEX), `${JSON.stringify({ ...index.data, entries: kept }, null, 2)}\n`);
  return { status: "updated", removed };
}

export async function restoreToIndex(projectPath: string, sessionId: string, entries: unknown[]): Promise<IndexStatus> {
  if (!entries.length) return "unchanged";
  const index = await readClaudeIndex(projectPath);
  if (index === "invalid") return "invalid";
  // A missing index is rebuilt by Claude Code from the transcripts; do not create one.
  if (index === "absent") return "absent";
  if (index.entries.some((entry) => entrySessionId(entry) === sessionId)) return "unchanged";
  const restored = entries.filter((entry) => entrySessionId(entry) === sessionId);
  if (!restored.length) return "unchanged";
  await writeAtomically(join(projectPath, SESSIONS_INDEX), `${JSON.stringify({ ...index.data, entries: [...index.entries, ...restored] }, null, 2)}\n`);
  return "updated";
}

// ---------------------------------------------------------------------------
// Codex: <root>/session_index.jsonl
// ---------------------------------------------------------------------------

export async function removeFromCodexIndex(rootPath: string, sessionId: string): Promise<{ status: IndexStatus; removed: unknown[] }> {
  const path = join(rootPath, CODEX_SESSION_INDEX);
  let raw: string;
  try {
    const info = await lstat(path);
    if (!info.isFile()) return { status: "invalid", removed: [] };
    raw = await readFile(path, "utf8");
  } catch {
    return { status: "absent", removed: [] };
  }
  const kept: string[] = [];
  const removed: unknown[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed) && parsed.id === sessionId) {
        removed.push(parsed);
        continue;
      }
      kept.push(line);
    } catch {
      kept.push(line);
    }
  }
  if (!removed.length) return { status: "unchanged", removed };
  await writeAtomically(path, kept.length ? `${kept.join("\n")}\n` : "");
  return { status: "updated", removed };
}

export async function restoreToCodexIndex(rootPath: string, sessionId: string, entries: unknown[]): Promise<IndexStatus> {
  if (!entries.length) return "unchanged";
  const path = join(rootPath, CODEX_SESSION_INDEX);
  let raw: string;
  try {
    const info = await lstat(path);
    if (!info.isFile()) return "invalid";
    raw = await readFile(path, "utf8");
  } catch {
    return "absent";
  }
  const existingLines = raw.split("\n").filter((line) => line.trim());
  for (const line of existingLines) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed) && parsed.id === sessionId) return "unchanged";
    } catch {
      // ignore
    }
  }
  const toAdd = entries.filter((entry) => isRecord(entry) && entry.id === sessionId).map((entry) => JSON.stringify(entry));
  if (!toAdd.length) return "unchanged";
  await writeAtomically(path, `${[...existingLines, ...toAdd].join("\n")}\n`);
  return "updated";
}

// ---------------------------------------------------------------------------
// Antigravity: <root>/cache/conversation_metadata.json + last_conversations.json
// ---------------------------------------------------------------------------

interface AntigravityIndexEntry {
  kind: "antigravity-meta" | "antigravity-last";
  sessionId: string;
  value?: unknown;
  workspaces?: string[];
}

export async function removeFromAntigravityIndex(rootPath: string, sessionId: string): Promise<{ status: IndexStatus; removed: unknown[] }> {
  const removed: AntigravityIndexEntry[] = [];
  let updated = false;

  const metaPath = join(rootPath, "cache", "conversation_metadata.json");
  const meta = await readJsonFile(metaPath);
  if (meta !== "absent" && meta !== "invalid" && isRecord(meta.data.conversations)) {
    const conversations = { ...meta.data.conversations };
    if (Object.prototype.hasOwnProperty.call(conversations, sessionId)) {
      removed.push({ kind: "antigravity-meta", sessionId, value: conversations[sessionId] });
      delete conversations[sessionId];
      await writeAtomically(metaPath, `${JSON.stringify({ ...meta.data, conversations }, null, 2)}\n`);
      updated = true;
    }
  }

  const lastPath = join(rootPath, "cache", "last_conversations.json");
  const last = await readJsonFile(lastPath);
  if (last !== "absent" && last !== "invalid") {
    const next = { ...last.data };
    const workspaces: string[] = [];
    for (const [ws, id] of Object.entries(next)) {
      if (id === sessionId) {
        workspaces.push(ws);
        delete next[ws];
      }
    }
    if (workspaces.length) {
      removed.push({ kind: "antigravity-last", sessionId, workspaces });
      await writeAtomically(lastPath, `${JSON.stringify(next, null, 2)}\n`);
      updated = true;
    }
  }

  return { status: updated ? "updated" : "unchanged", removed };
}

export async function restoreToAntigravityIndex(rootPath: string, sessionId: string, entries: unknown[]): Promise<IndexStatus> {
  if (!entries.length) return "unchanged";
  let updated = false;
  for (const rawEntry of entries) {
    if (!isRecord(rawEntry) || rawEntry.sessionId !== sessionId) continue;
    if (rawEntry.kind === "antigravity-meta" && rawEntry.value !== undefined) {
      const metaPath = join(rootPath, "cache", "conversation_metadata.json");
      const meta = await readJsonFile(metaPath);
      if (meta !== "absent" && meta !== "invalid" && isRecord(meta.data.conversations)) {
        if (!Object.prototype.hasOwnProperty.call(meta.data.conversations, sessionId)) {
          const conversations = { ...meta.data.conversations, [sessionId]: rawEntry.value };
          await writeAtomically(metaPath, `${JSON.stringify({ ...meta.data, conversations }, null, 2)}\n`);
          updated = true;
        }
      }
    } else if (rawEntry.kind === "antigravity-last" && Array.isArray(rawEntry.workspaces)) {
      const lastPath = join(rootPath, "cache", "last_conversations.json");
      const last = await readJsonFile(lastPath);
      if (last !== "absent" && last !== "invalid") {
        const next = { ...last.data };
        let changed = false;
        for (const ws of rawEntry.workspaces) {
          if (typeof ws === "string" && !Object.prototype.hasOwnProperty.call(next, ws)) {
            next[ws] = sessionId;
            changed = true;
          }
        }
        if (changed) {
          await writeAtomically(lastPath, `${JSON.stringify(next, null, 2)}\n`);
          updated = true;
        }
      }
    }
  }
  return updated ? "updated" : "unchanged";
}
