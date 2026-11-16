import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ScanWarning } from "../shared/schema";
import { firstSessionId, parseTranscript, type ParsedTranscript } from "./parser";
import type { ClaudeRoot } from "./roots";
import { treeSize } from "./safety";

/**
 * Builds the catalog of every Claude Code session under each configuration directory:
 *
 *   <root>/projects/<project dir>/<session id>.jsonl          main transcript
 *   <root>/projects/<project dir>/<session id>/subagents/*.jsonl   subagent transcripts (current layout)
 *   <root>/projects/<project dir>/<session id>/...            tool results and other per-session data
 *   <root>/projects/<project dir>/agent-*.jsonl               subagent transcripts (older layout)
 *
 * Other entries of a project directory, such as `memory/` or `sessions-index.json`, are never
 * treated as session data.
 */

export const PROJECT_DIR = /^(?!\.\.?$)[A-Za-z0-9._-]{1,255}$/;
export const SESSION_FILE = /^(?!agent-)([A-Za-z0-9][A-Za-z0-9._-]{0,200})\.jsonl$/;
export const LEGACY_AGENT_FILE = /^agent-[A-Za-z0-9._-]{1,200}\.jsonl$/;
/** Directory names inside a project directory that belong to Claude, not to a session. */
const RESERVED_DIRS = new Set(["memory"]);

export interface FileInfo {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface CatalogSession {
  key: string;
  root: ClaudeRoot;
  projectDir: string;
  projectKey: string;
  /** Absolute path of the project directory. */
  projectPath: string;
  sessionId: string;
  transcript: FileInfo;
  /** `<project dir>/<session id>/`, when present. */
  sessionDir: string | null;
  sessionDirBytes: number;
  sessionDirNewestMs: number;
  subagentCount: number;
  legacyAgents: FileInfo[];
  parsed: ParsedTranscript;
}

export interface CatalogProject {
  key: string;
  root: ClaudeRoot;
  directory: string;
  path: string;
  label: string;
  sessions: string[];
}

export interface ScanResult {
  roots: ClaudeRoot[];
  sessions: Map<string, CatalogSession>;
  projects: Map<string, CatalogProject>;
  /** Session ID to catalog keys, across all roots. More than one key means a duplicate ID. */
  bySessionId: Map<string, string[]>;
  warnings: ScanWarning[];
}

export type Progress = (done: number, total: number) => void;

const MAX_WARNINGS = 50;
const PARSE_CONCURRENCY = 4;

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? "";
}

export function sessionKey(rootId: string, projectDir: string, sessionId: string): string {
  return `${rootId}/${projectDir}/${sessionId}`;
}

async function countJsonl(directory: string, depth = 0): Promise<number> {
  if (depth > 8) return 0;
  let count = 0;
  let list: Dirent[];
  try {
    list = await readdir(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of list) {
    if (entry.isDirectory()) count += await countJsonl(join(directory, entry.name), depth + 1);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) count += 1;
  }
  return count;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export class Scanner {
  private parsed = new Map<string, { size: number; mtimeMs: number; value: ParsedTranscript }>();
  private legacy = new Map<string, { size: number; mtimeMs: number; sessionId: string }>();

  async scan(roots: ClaudeRoot[], onProgress?: Progress): Promise<ScanResult> {
    const warnings: ScanWarning[] = [];
    const warn = (code: ScanWarning["code"], path: string) => {
      if (warnings.length < MAX_WARNINGS) warnings.push({ code, path });
    };
    const list = async (path: string): Promise<Dirent[]> => {
      try {
        return await readdir(path, { withFileTypes: true });
      } catch (error) {
        if (!["ENOENT", "ENOTDIR"].includes(errorCode(error))) warn("unreadable_dir", path);
        return [];
      }
    };
    const info = async (path: string): Promise<FileInfo | null> => {
      try {
        const s = await lstat(path);
        return s.isFile() ? { path, size: s.size, mtimeMs: s.mtimeMs } : null;
      } catch {
        warn("unreadable_file", path);
        return null;
      }
    };

    interface Pending {
      root: ClaudeRoot;
      projectDir: string;
      projectPath: string;
      sessionId: string;
      transcript: FileInfo;
      hasDir: boolean;
      legacy: FileInfo[];
    }
    const pending: Pending[] = [];
    const seenPaths = new Set<string>();

    for (const root of roots) {
      if (!root.available) continue;
      const projectsPath = join(root.real, "projects");
      for (const projectEntry of await list(projectsPath)) {
        if (!projectEntry.isDirectory() || !PROJECT_DIR.test(projectEntry.name)) continue;
        const projectPath = join(projectsPath, projectEntry.name);
        const transcripts = new Map<string, FileInfo>();
        const directories = new Set<string>();
        const legacyBySession = new Map<string, FileInfo[]>();
        for (const entry of await list(projectPath)) {
          const path = join(projectPath, entry.name);
          if (entry.isDirectory()) {
            if (!RESERVED_DIRS.has(entry.name)) directories.add(entry.name);
            continue;
          }
          if (!entry.isFile()) continue;
          if (LEGACY_AGENT_FILE.test(entry.name)) {
            const file = await info(path);
            if (!file) continue;
            seenPaths.add(path);
            const cached = this.legacy.get(path);
            let sessionId = cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs ? cached.sessionId : null;
            if (sessionId === null) {
              try {
                sessionId = await firstSessionId(path);
              } catch {
                warn("unreadable_file", path);
                sessionId = "";
              }
              this.legacy.set(path, { size: file.size, mtimeMs: file.mtimeMs, sessionId });
            }
            if (sessionId) legacyBySession.set(sessionId, [...(legacyBySession.get(sessionId) ?? []), file]);
            continue;
          }
          const match = SESSION_FILE.exec(entry.name);
          if (!match) continue;
          const file = await info(path);
          if (file) transcripts.set(match[1], file);
        }
        for (const [sessionId, transcript] of transcripts) {
          seenPaths.add(transcript.path);
          pending.push({
            root, projectDir: projectEntry.name, projectPath, sessionId, transcript,
            hasDir: directories.has(sessionId), legacy: legacyBySession.get(sessionId) ?? [],
          });
        }
      }
    }

    let done = 0;
    onProgress?.(0, pending.length);
    const results = new Map<Pending, ParsedTranscript>();
    await mapLimit(pending, PARSE_CONCURRENCY, async (item) => {
      const { path, size, mtimeMs } = item.transcript;
      const cached = this.parsed.get(path);
      let value = cached && cached.size === size && cached.mtimeMs === mtimeMs ? cached.value : null;
      if (!value) {
        try {
          value = await parseTranscript(path);
        } catch {
          warn("unreadable_file", path);
          value = null;
        }
        if (value) this.parsed.set(path, { size, mtimeMs, value });
      }
      if (value) results.set(item, value);
      done += 1;
      onProgress?.(done, pending.length);
    });

    // Drop cached text of transcripts that no longer exist, including deleted sessions.
    for (const path of this.parsed.keys()) if (!seenPaths.has(path)) this.parsed.delete(path);
    for (const path of this.legacy.keys()) if (!seenPaths.has(path)) this.legacy.delete(path);

    const sessions = new Map<string, CatalogSession>();
    const projects = new Map<string, CatalogProject>();
    const bySessionId = new Map<string, string[]>();
    const cwdVotes = new Map<string, Map<string, number>>();
    for (const item of pending) {
      const parsed = results.get(item);
      if (!parsed) continue;
      const key = sessionKey(item.root.id, item.projectDir, item.sessionId);
      const projectKey = `${item.root.id}/${item.projectDir}`;
      let sessionDir: string | null = null;
      let sessionDirBytes = 0;
      let sessionDirNewestMs = 0;
      let subagentCount = 0;
      if (item.hasDir) {
        sessionDir = join(item.projectPath, item.sessionId);
        try {
          const size = await treeSize(sessionDir);
          sessionDirBytes = size.bytes;
          sessionDirNewestMs = size.newestMs;
          subagentCount = await countJsonl(join(sessionDir, "subagents"));
        } catch {
          warn("unreadable_dir", sessionDir);
        }
      }
      sessions.set(key, {
        key, root: item.root, projectDir: item.projectDir, projectKey, projectPath: item.projectPath,
        sessionId: item.sessionId, transcript: item.transcript, sessionDir, sessionDirBytes, sessionDirNewestMs,
        subagentCount: subagentCount + item.legacy.length, legacyAgents: item.legacy, parsed,
      });
      bySessionId.set(item.sessionId, [...(bySessionId.get(item.sessionId) ?? []), key]);
      let project = projects.get(projectKey);
      if (!project) {
        project = { key: projectKey, root: item.root, directory: item.projectDir, path: item.projectPath, label: item.projectDir, sessions: [] };
        projects.set(projectKey, project);
      }
      project.sessions.push(key);
      if (parsed.cwd) {
        const votes = cwdVotes.get(projectKey) ?? new Map<string, number>();
        votes.set(parsed.cwd, (votes.get(parsed.cwd) ?? 0) + 1);
        cwdVotes.set(projectKey, votes);
      }
    }
    for (const [projectKey, votes] of cwdVotes) {
      const project = projects.get(projectKey);
      const best = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      if (project && best) project.label = best[0];
    }
    return { roots, sessions, projects, bySessionId, warnings };
  }
}
