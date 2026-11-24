import { createHash } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { FileKind } from "../shared/schema";
import { sessionIdLookupKey, type CatalogSession, type ScanResult } from "./scanner";
import { SAFE_SEGMENT, toRelative, treeSize } from "./safety";

/**
 * The complete, fixed list of locations a session may own, per provider. Nothing outside this
 * list is ever moved: settings, credentials, prompt history, skills, plugins, MCP configuration,
 * project memory, shared SQLite databases, and source trees are out of reach by construction.
 *
 * Claude Code:
 *   Per transcript: projects/<dir>/<id>.jsonl, projects/<dir>/<id>/, projects/<dir>/agent-*.jsonl
 *   Per session ID: todos/<id>*.json, file-history/<id>/, session-env/<id>/, debug/<id>.txt, tasks/<id>/
 *
 * Codex:
 *   Per rollout:    sessions/.../rollout-...-<id>.jsonl (or archived_sessions/rollout-...-<id>.jsonl)
 *   Per session ID: tui-thread-reference-capabilities/<id>, shell_snapshots/<id>*.sh
 *
 * Antigravity:
 *   Per conversation: conversations/<id>.db, brain/<id>/, annotations/<id>.pbtxt, presence/<id>.lock
 */

export interface PlannedFile {
  absolute: string;
  rel: string;
  kind: FileKind;
  bytes: number;
  newestMs: number;
}

export interface Plan {
  files: PlannedFile[];
  /** Shared files kept because a duplicate transcript still uses this session ID. */
  keptShared: PlannedFile[];
  fingerprint: string;
}

async function entry(root: string, absolute: string, kind: FileKind): Promise<PlannedFile | null> {
  try {
    const info = await lstat(absolute);
    // Symbolic links are never followed or moved.
    if (info.isSymbolicLink()) return null;
    const size = info.isDirectory() ? await treeSize(absolute) : { bytes: info.size, newestMs: info.mtimeMs };
    return { absolute, rel: toRelative(root, absolute), kind, bytes: size.bytes, newestMs: size.newestMs };
  } catch {
    return null;
  }
}

async function claudeSharedArtifacts(root: string, sessionId: string): Promise<PlannedFile[]> {
  if (!SAFE_SEGMENT.test(sessionId)) return [];
  const result: PlannedFile[] = [];
  const add = async (absolute: string, kind: FileKind) => {
    const file = await entry(root, absolute, kind);
    if (file) result.push(file);
  };
  try {
    for (const name of await readdir(join(root, "todos"))) {
      if (name === `${sessionId}.json` || (name.startsWith(`${sessionId}-agent-`) && name.endsWith(".json"))) {
        await add(join(root, "todos", name), "todo");
      }
    }
  } catch {
    // No todos directory.
  }
  await add(join(root, "file-history", sessionId), "file-history");
  await add(join(root, "session-env", sessionId), "session-env");
  await add(join(root, "debug", `${sessionId}.txt`), "debug");
  await add(join(root, "tasks", sessionId), "tasks");
  return result;
}

async function codexSharedArtifacts(root: string, sessionId: string): Promise<PlannedFile[]> {
  if (!SAFE_SEGMENT.test(sessionId)) return [];
  const result: PlannedFile[] = [];
  const add = async (absolute: string, kind: FileKind) => {
    const file = await entry(root, absolute, kind);
    if (file) result.push(file);
  };
  await add(join(root, "tui-thread-reference-capabilities", sessionId), "codex-capabilities");
  try {
    for (const name of await readdir(join(root, "shell_snapshots"))) {
      if (name === `${sessionId}.sh` || (name.startsWith(`${sessionId}.`) && name.endsWith(".sh"))) {
        await add(join(root, "shell_snapshots", name), "shell-snapshot");
      }
    }
  } catch {
    // No shell_snapshots directory.
  }
  return result;
}

export function fingerprintOf(files: PlannedFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) {
    hash.update(`${file.rel}\0${file.kind}\0${file.bytes}\0${Math.trunc(file.newestMs)}\n`);
  }
  return hash.digest("hex");
}

export async function planSession(session: CatalogSession, scan: ScanResult): Promise<Plan> {
  const root = session.root.real;
  const files: PlannedFile[] = [];
  const lookup = sessionIdLookupKey(session.provider, session.sessionId);
  const siblings = (scan.bySessionId.get(lookup) ?? []).filter(
    (key) => key !== session.key && scan.sessions.get(key)?.root.id === session.root.id,
  );

  if (session.provider === "claude") {
    const transcript = await entry(root, session.transcript.path, "transcript");
    if (transcript) files.push(transcript);
    if (session.sessionDir) {
      const dir = await entry(root, session.sessionDir, "session-dir");
      if (dir) files.push(dir);
    }
    for (const legacy of session.legacyAgents) {
      const file = await entry(root, legacy.path, "legacy-subagent");
      if (file) files.push(file);
    }
    const shared = await claudeSharedArtifacts(root, session.sessionId);
    const keptShared = siblings.length ? shared : [];
    if (!siblings.length) files.push(...shared);
    return { files, keptShared, fingerprint: fingerprintOf(files) };
  }

  if (session.provider === "codex") {
    const rollout = await entry(root, session.transcript.path, "rollout");
    if (rollout) files.push(rollout);
    const shared = await codexSharedArtifacts(root, session.sessionId);
    const keptShared = siblings.length ? shared : [];
    if (!siblings.length) files.push(...shared);
    return { files, keptShared, fingerprint: fingerprintOf(files) };
  }

  // Antigravity
  if (SAFE_SEGMENT.test(session.sessionId)) {
    const db = await entry(root, join(root, "conversations", `${session.sessionId}.db`), "conversation-db");
    if (db) files.push(db);
    const brain = await entry(root, join(root, "brain", session.sessionId), "brain-dir");
    if (brain) files.push(brain);
    const annotation = await entry(root, join(root, "annotations", `${session.sessionId}.pbtxt`), "annotation");
    if (annotation) files.push(annotation);
    const presence = await entry(root, join(root, "presence", `${session.sessionId}.lock`), "presence");
    if (presence) files.push(presence);
  }
  return { files, keptShared: [], fingerprint: fingerprintOf(files) };
}
