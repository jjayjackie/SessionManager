import { randomBytes } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Some Claude Code versions cache session summaries for `/resume` in
 * `projects/<dir>/sessions-index.json` (`{ entries: [{ sessionId, ... }] }`). After a delete the
 * matching entries are removed so `/resume` does not list a session whose transcript is gone; a
 * restore puts them back. Unknown fields are preserved. A file that cannot be parsed, or that has
 * no `entries` array, is left untouched.
 */

export const SESSIONS_INDEX = "sessions-index.json";

export type IndexStatus = "absent" | "unchanged" | "updated" | "invalid";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readIndex(projectPath: string): Promise<{ data: Record<string, unknown>; entries: unknown[] } | "absent" | "invalid"> {
  const path = join(projectPath, SESSIONS_INDEX);
  try {
    const info = await lstat(path);
    if (!info.isFile()) return "invalid";
  } catch {
    return "absent";
  }
  try {
    const data: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(data) || !Array.isArray(data.entries)) return "invalid";
    return { data, entries: data.entries };
  } catch {
    return "invalid";
  }
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const temporary = `${path}.csm-${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function entrySessionId(entry: unknown): string {
  return isRecord(entry) && typeof entry.sessionId === "string" ? entry.sessionId : "";
}

export async function removeFromIndex(projectPath: string, sessionId: string): Promise<{ status: IndexStatus; removed: unknown[] }> {
  const index = await readIndex(projectPath);
  if (index === "absent" || index === "invalid") return { status: index, removed: [] };
  const removed = index.entries.filter((entry) => entrySessionId(entry) === sessionId);
  if (!removed.length) return { status: "unchanged", removed };
  const kept = index.entries.filter((entry) => entrySessionId(entry) !== sessionId);
  await writeAtomically(join(projectPath, SESSIONS_INDEX), `${JSON.stringify({ ...index.data, entries: kept }, null, 2)}\n`);
  return { status: "updated", removed };
}

export async function restoreToIndex(projectPath: string, sessionId: string, entries: unknown[]): Promise<IndexStatus> {
  if (!entries.length) return "unchanged";
  const index = await readIndex(projectPath);
  if (index === "invalid") return "invalid";
  // A missing index is rebuilt by Claude Code from the transcripts; do not create one.
  if (index === "absent") return "absent";
  if (index.entries.some((entry) => entrySessionId(entry) === sessionId)) return "unchanged";
  const restored = entries.filter((entry) => entrySessionId(entry) === sessionId);
  if (!restored.length) return "unchanged";
  await writeAtomically(join(projectPath, SESSIONS_INDEX), `${JSON.stringify({ ...index.data, entries: [...index.entries, ...restored] }, null, 2)}\n`);
  return "updated";
}
