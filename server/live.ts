import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderId } from "../shared/schema";

/**
 * Which sessions are in use. A session is protected from deletion when any of these hold:
 * - Claude Code: `<root>/sessions/<pid>.json` names it and the process is alive;
 * - Antigravity: `conversations/<id>.db-wal` or `.db-shm` exists (SQLite WAL held open by a live process);
 * - Codex: its rollout or `thread-writer-locks/<id>.lock` was written within `recentMs`;
 * - Any provider: its session files were written within `recentMs`, or a Paseo agent bound to it
 *   last reported a running or initializing status.
 */

export type AliveCheck = (pid: number) => boolean;

export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

/** Session IDs owned by live native processes under one provider directory. */
export async function liveSessionIds(rootPath: string, provider: ProviderId = "claude", alive: AliveCheck = processAlive): Promise<Set<string>> {
  const result = new Set<string>();
  if (provider === "claude") {
    let names: string[];
    try {
      names = await readdir(join(rootPath, "sessions"));
    } catch {
      return result;
    }
    for (const name of names) {
      if (!/^\d+\.json$/.test(name)) continue;
      const record = object(await readJson(join(rootPath, "sessions", name)));
      const sessionId = record.sessionId;
      const pid = typeof record.pid === "number" ? record.pid : Number(name.slice(0, -5));
      if (typeof sessionId === "string" && sessionId && alive(pid)) result.add(sessionId);
    }
    return result;
  }

  if (provider === "antigravity") {
    let names: string[];
    try {
      names = await readdir(join(rootPath, "conversations"));
    } catch {
      return result;
    }
    for (const name of names) {
      const match = /^(.+)\.db-(?:wal|shm)$/.exec(name);
      if (match) result.add(match[1]);
    }
    return result;
  }

  // Codex relies on advisory flock files (`thread-writer-locks/*.lock`) that persist after exit,
  // so liveness is checked via recent mtime + Paseo running agents rather than stale lock presence.
  return result;
}

/** Newest lock mtime for Codex `thread-writer-locks/<id>.lock` if present. */
export async function codexLockMtime(rootPath: string, sessionId: string): Promise<number> {
  try {
    const info = await lstat(join(rootPath, "thread-writer-locks", `${sessionId}.lock`));
    return info.isFile() ? info.mtimeMs : 0;
  } catch {
    return 0;
  }
}

export interface PaseoAgent {
  agentId: string;
  provider: string;
  title: string;
  archived: boolean;
  status: string;
  createdAt: string;
}

/**
 * Paseo agent records keyed by provider session ID. Only an allowlist of fields is read; the
 * `persistence.metadata` object may contain credentials and is never retained.
 */
export async function paseoAgents(paseoHomePath: string): Promise<Map<string, PaseoAgent>> {
  const result = new Map<string, PaseoAgent>();
  const base = join(paseoHomePath, "agents");
  let directories: string[];
  try {
    directories = await readdir(base);
  } catch {
    return result;
  }
  for (const directory of directories) {
    let files: string[];
    try {
      files = await readdir(join(base, directory));
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const a = object(await readJson(join(base, directory, file)));
      const p = object(a.persistence);
      const nativeId = typeof p.sessionId === "string" && p.sessionId ? p.sessionId : typeof p.nativeHandle === "string" ? p.nativeHandle : "";
      const agentId = typeof a.id === "string" ? a.id : "";
      if (!nativeId || !agentId) continue;
      const agent: PaseoAgent = {
        agentId,
        provider: typeof a.provider === "string" ? a.provider : typeof p.provider === "string" ? p.provider : "",
        title: typeof a.title === "string" ? a.title.slice(0, 200) : "",
        archived: Boolean(a.archivedAt),
        status: typeof a.lastStatus === "string" ? a.lastStatus : "unknown",
        createdAt: typeof a.createdAt === "string" ? a.createdAt : "",
      };
      const previous = result.get(nativeId);
      // Several records can resume one provider session; prefer the live, then the newest one.
      if (!previous || (previous.archived && !agent.archived) || (previous.archived === agent.archived && agent.createdAt > previous.createdAt)) {
        result.set(nativeId, agent);
      }
    }
  }
  return result;
}

export function paseoAgentRunning(agent: PaseoAgent | undefined): boolean {
  return Boolean(agent && !agent.archived && (agent.status === "running" || agent.status === "initializing"));
}
