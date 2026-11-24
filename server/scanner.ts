import type { Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProviderId, ScanWarning } from "../shared/schema";
import {
  metadataOnlyTranscript,
  parseAntigravityTranscript,
  readAntigravityMetadata,
  type AntigravityMeta,
  type ParsedAntigravityTranscript,
} from "./antigravity-parser";
import { extractCodexSessionId, parseCodexRollout, readCodexSessionNames } from "./codex-parser";
import { firstSessionId, parseTranscript, type ParsedTranscript } from "./parser";
import type { AgentRoot } from "./roots";
import { SAFE_SEGMENT, toRelative, treeSize } from "./safety";

/**
 * Builds the unified catalog of sessions across Claude Code, Codex, and Antigravity:
 *
 * - Claude Code:
 *     <root>/projects/<project dir>/<session id>.jsonl
 *     <root>/projects/<project dir>/<session id>/subagents/*.jsonl
 *     <root>/projects/<project dir>/agent-*.jsonl
 * - Codex:
 *     <root>/sessions/YYYY/MM/DD/rollout-<ts>-<session id>.jsonl
 *     <root>/archived_sessions/rollout-<ts>-<session id>.jsonl
 * - Antigravity:
 *     <root>/conversations/<conversation id>.db
 *     <root>/brain/<conversation id>/.system_generated/logs/transcript.jsonl
 *     <root>/cache/conversation_metadata.json
 */

export const PROJECT_DIR = /^(?!\.\.?$)[A-Za-z0-9._-]{1,255}$/;
export const SESSION_FILE = /^(?!agent-)([A-Za-z0-9][A-Za-z0-9._-]{0,200})\.jsonl$/;
export const LEGACY_AGENT_FILE = /^agent-[A-Za-z0-9._-]{1,200}\.jsonl$/;
export const CODEX_ROLLOUT_FILE = /^rollout-[A-Za-z0-9._-]{1,220}\.jsonl$/;
const RESERVED_DIRS = new Set(["memory"]);

export interface FileInfo {
  path: string;
  size: number;
  mtimeMs: number;
}

export interface CatalogSession {
  key: string;
  provider: ProviderId;
  root: AgentRoot;
  /** Storage scope within the provider root (Claude project dir, Codex relative dir, or "conversations"). */
  projectDir: string;
  /** Unified project group key (normalized cwd when known, else provider/root/projectDir). */
  projectKey: string;
  /** Human-readable project path or folder name. */
  projectLabel: string;
  /** Absolute path of the directory containing the transcript/index (used for Claude sessions-index.json). */
  projectPath: string;
  sessionId: string;
  /** Primary file (Claude .jsonl, Codex rollout .jsonl, or Antigravity .db / transcript.jsonl). */
  transcript: FileInfo;
  /** Antigravity brain transcript.jsonl path when present, used for preview streaming. */
  antigravityTranscriptPath: string | null;
  /** Claude `<project dir>/<session id>/` or Antigravity `brain/<id>/`, when present. */
  sessionDir: string | null;
  sessionDirBytes: number;
  sessionDirNewestMs: number;
  /** Additional single-file bytes counted in summary (e.g. Antigravity annotation/presence). */
  extraBytes: number;
  extraNewestMs: number;
  subagentCount: number;
  legacyAgents: FileInfo[];
  parsed: ParsedTranscript;
}

export interface ScanResult {
  roots: AgentRoot[];
  sessions: Map<string, CatalogSession>;
  /** Keyed by `${provider}:${sessionId}`. More than one catalog key means a duplicate ID. */
  bySessionId: Map<string, string[]>;
  warnings: ScanWarning[];
}

export type Progress = (done: number, total: number) => void;

const MAX_WARNINGS = 50;
const PARSE_CONCURRENCY = 4;

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? "";
}

export function sessionKey(rootId: string, projectDir: string, sessionId: string, provider: ProviderId = "claude"): string {
  return provider === "claude" ? `${rootId}/${projectDir}/${sessionId}` : `${provider}/${rootId}/${projectDir}/${sessionId}`;
}

export function sessionIdLookupKey(provider: ProviderId, sessionId: string): string {
  return `${provider}:${sessionId}`;
}

export function normalizeCwd(cwd: string): string {
  const trimmed = cwd.trim();
  if (!trimmed) return "";
  if (trimmed === "/") return "/";
  return trimmed.replace(/[\\/]+$/, "");
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

interface PendingClaude {
  kind: "claude";
  root: AgentRoot;
  projectDir: string;
  projectPath: string;
  sessionId: string;
  transcript: FileInfo;
  hasDir: boolean;
  legacy: FileInfo[];
}

interface PendingCodex {
  kind: "codex";
  root: AgentRoot;
  relDir: string;
  sessionId: string;
  transcript: FileInfo;
  indexTitle: string;
}

interface PendingAntigravity {
  kind: "antigravity";
  root: AgentRoot;
  sessionId: string;
  dbFile: FileInfo | null;
  brainDir: string | null;
  transcriptFile: FileInfo | null;
  annotationFile: FileInfo | null;
  presenceFile: FileInfo | null;
  meta?: AntigravityMeta;
}

type PendingItem = PendingClaude | PendingCodex | PendingAntigravity;

export class Scanner {
  private parsed = new Map<string, { size: number; mtimeMs: number; metaHash: string; value: ParsedTranscript; subagentCount: number }>();
  private legacy = new Map<string, { size: number; mtimeMs: number; sessionId: string }>();

  async scan(roots: AgentRoot[], onProgress?: Progress): Promise<ScanResult> {
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
    const info = async (path: string, reportMissing = true): Promise<FileInfo | null> => {
      try {
        const s = await lstat(path);
        return s.isFile() ? { path, size: s.size, mtimeMs: s.mtimeMs } : null;
      } catch (error) {
        if (reportMissing && errorCode(error) !== "ENOENT") warn("unreadable_file", path);
        return null;
      }
    };

    const pending: PendingItem[] = [];
    const seenPaths = new Set<string>();

    const walkCodexRollouts = async (root: AgentRoot, dir: string, names: Map<string, string>, depth = 0): Promise<void> => {
      if (depth > 8) return;
      for (const entry of await list(dir)) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (SAFE_SEGMENT.test(entry.name)) await walkCodexRollouts(root, full, names, depth + 1);
          continue;
        }
        if (!entry.isFile() || !CODEX_ROLLOUT_FILE.test(entry.name)) continue;
        const file = await info(full);
        if (!file) continue;
        const sessionId = extractCodexSessionId(entry.name);
        if (!SAFE_SEGMENT.test(sessionId)) continue;
        seenPaths.add(file.path);
        const relDir = toRelative(root.real, dirname(full));
        pending.push({
          kind: "codex",
          root,
          relDir,
          sessionId,
          transcript: file,
          indexTitle: names.get(sessionId) ?? "",
        });
      }
    };

    for (const root of roots) {
      if (!root.available) continue;

      if (root.provider === "claude") {
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
              kind: "claude",
              root,
              projectDir: projectEntry.name,
              projectPath,
              sessionId,
              transcript,
              hasDir: directories.has(sessionId),
              legacy: legacyBySession.get(sessionId) ?? [],
            });
          }
        }
        continue;
      }

      if (root.provider === "codex") {
        const names = await readCodexSessionNames(root.real);
        await walkCodexRollouts(root, join(root.real, "sessions"), names);
        await walkCodexRollouts(root, join(root.real, "archived_sessions"), names);
        continue;
      }

      // Antigravity
      const metadata = await readAntigravityMetadata(root.real);
      const dbFiles = new Map<string, FileInfo>();
      const brainDirs = new Map<string, string>();
      for (const entry of await list(join(root.real, "conversations"))) {
        if (!entry.isFile() || !entry.name.endsWith(".db")) continue;
        const id = entry.name.slice(0, -3);
        if (!SAFE_SEGMENT.test(id)) continue;
        const file = await info(join(root.real, "conversations", entry.name));
        if (file) dbFiles.set(id, file);
      }
      for (const entry of await list(join(root.real, "brain"))) {
        if (!entry.isDirectory() || !SAFE_SEGMENT.test(entry.name)) continue;
        brainDirs.set(entry.name, join(root.real, "brain", entry.name));
      }
      const allIds = new Set([...dbFiles.keys(), ...brainDirs.keys()]);
      for (const sessionId of allIds) {
        const meta = metadata.get(sessionId);
        if (meta?.internal) continue;
        const brainDir = brainDirs.get(sessionId) ?? null;
        const transcriptFile = brainDir ? await info(join(brainDir, ".system_generated", "logs", "transcript.jsonl"), false) : null;
        const annotationFile = await info(join(root.real, "annotations", `${sessionId}.pbtxt`), false);
        const presenceFile = await info(join(root.real, "presence", `${sessionId}.lock`), false);
        // Antigravity eagerly pre-allocates 0-step empty SQLite shells (384 KB) whenever `agy` or
        // an ACP host opens a workspace, even if no prompt is ever sent. Skip those unstarted shells
        // so they do not pollute the session list or create phantom project entries.
        const hasActivity = Boolean(transcriptFile || annotationFile || (meta && (meta.numSteps > 0 || meta.title || meta.preview)));
        if (!hasActivity) continue;
        if (transcriptFile) seenPaths.add(transcriptFile.path);
        pending.push({
          kind: "antigravity",
          root,
          sessionId,
          dbFile: dbFiles.get(sessionId) ?? null,
          brainDir,
          transcriptFile,
          annotationFile,
          presenceFile,
          meta,
        });
      }
    }

    let done = 0;
    onProgress?.(0, pending.length);
    const parsedMap = new Map<PendingItem, { parsed: ParsedTranscript; extraSubagents: number }>();

    await mapLimit(pending, PARSE_CONCURRENCY, async (item) => {
      if (item.kind === "claude") {
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
          if (value) this.parsed.set(path, { size, mtimeMs, metaHash: "", value, subagentCount: 0 });
        }
        if (value) parsedMap.set(item, { parsed: value, extraSubagents: 0 });
      } else if (item.kind === "codex") {
        const { path, size, mtimeMs } = item.transcript;
        const metaHash = item.indexTitle;
        const cached = this.parsed.get(path);
        let value = cached && cached.size === size && cached.mtimeMs === mtimeMs && cached.metaHash === metaHash ? cached.value : null;
        if (!value) {
          try {
            value = await parseCodexRollout(path);
            if (item.indexTitle && !value.customTitle) {
              value.customTitle = item.indexTitle;
              value.searchText = value.searchText ? `${value.searchText}\n${item.indexTitle.toLowerCase()}` : item.indexTitle.toLowerCase();
            }
          } catch {
            warn("unreadable_file", path);
            value = null;
          }
          if (value) this.parsed.set(path, { size, mtimeMs, metaHash, value, subagentCount: 0 });
        }
        if (value) parsedMap.set(item, { parsed: value, extraSubagents: 0 });
      } else {
        const metaHash = item.meta ? `${item.meta.title}|${item.meta.cwd}|${item.meta.updatedAt ?? ""}` : "";
        let result: ParsedAntigravityTranscript | null = null;
        if (item.transcriptFile) {
          const { path, size, mtimeMs } = item.transcriptFile;
          const cached = this.parsed.get(path);
          if (cached && cached.size === size && cached.mtimeMs === mtimeMs && cached.metaHash === metaHash) {
            result = { parsed: cached.value, subagentCount: cached.subagentCount };
          } else {
            try {
              result = await parseAntigravityTranscript(path, item.sessionId, item.meta);
              this.parsed.set(path, { size, mtimeMs, metaHash, value: result.parsed, subagentCount: result.subagentCount });
            } catch {
              warn("unreadable_file", path);
              result = metadataOnlyTranscript(item.sessionId, item.meta);
            }
          }
        } else {
          result = metadataOnlyTranscript(item.sessionId, item.meta);
        }
        if (result) parsedMap.set(item, { parsed: result.parsed, extraSubagents: result.subagentCount });
      }
      done += 1;
      onProgress?.(done, pending.length);
    });

    // Drop cached text of transcripts that no longer exist, including deleted sessions.
    for (const path of this.parsed.keys()) if (!seenPaths.has(path)) this.parsed.delete(path);
    for (const path of this.legacy.keys()) if (!seenPaths.has(path)) this.legacy.delete(path);

    const sessions = new Map<string, CatalogSession>();
    const bySessionId = new Map<string, string[]>();
    const claudeDirVotes = new Map<string, Map<string, number>>();
    const claudeRaw: CatalogSession[] = [];

    for (const item of pending) {
      const entry = parsedMap.get(item);
      if (!entry) continue;
      const { parsed, extraSubagents } = entry;

      if (item.kind === "claude") {
        const key = sessionKey(item.root.id, item.projectDir, item.sessionId, "claude");
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
        const normalized = normalizeCwd(parsed.cwd);
        const dirGroupKey = `${item.root.id}/${item.projectDir}`;
        if (normalized) {
          const votes = claudeDirVotes.get(dirGroupKey) ?? new Map<string, number>();
          votes.set(normalized, (votes.get(normalized) ?? 0) + 1);
          claudeDirVotes.set(dirGroupKey, votes);
        }
        const catalogSession: CatalogSession = {
          key,
          provider: "claude",
          root: item.root,
          projectDir: item.projectDir,
          projectKey: normalized ? `cwd:${normalized}` : `dir:claude/${item.root.id}/${item.projectDir}`,
          projectLabel: normalized || item.projectDir,
          projectPath: item.projectPath,
          sessionId: item.sessionId,
          transcript: item.transcript,
          antigravityTranscriptPath: null,
          sessionDir,
          sessionDirBytes,
          sessionDirNewestMs,
          extraBytes: 0,
          extraNewestMs: 0,
          subagentCount: subagentCount + item.legacy.length,
          legacyAgents: item.legacy,
          parsed,
        };
        claudeRaw.push(catalogSession);
        sessions.set(key, catalogSession);
        const lookup = sessionIdLookupKey("claude", item.sessionId);
        bySessionId.set(lookup, [...(bySessionId.get(lookup) ?? []), key]);
      } else if (item.kind === "codex") {
        const canonicalId = parsed.sessionIds[0] && SAFE_SEGMENT.test(parsed.sessionIds[0]) ? parsed.sessionIds[0] : item.sessionId;
        let key = sessionKey(item.root.id, item.relDir, canonicalId, "codex");
        if (sessions.has(key)) {
          // Two rollouts in the same directory share a session ID: disambiguate by filename stem.
          key = sessionKey(item.root.id, item.relDir, toRelative(item.root.real, item.transcript.path).replace(/\.jsonl$/, ""), "codex");
        }
        const normalized = normalizeCwd(parsed.cwd);
        const catalogSession: CatalogSession = {
          key,
          provider: "codex",
          root: item.root,
          projectDir: item.relDir,
          projectKey: normalized ? `cwd:${normalized}` : `dir:codex/${item.root.id}/${item.relDir}`,
          projectLabel: normalized || item.relDir,
          projectPath: dirname(item.transcript.path),
          sessionId: canonicalId,
          transcript: item.transcript,
          antigravityTranscriptPath: null,
          sessionDir: null,
          sessionDirBytes: 0,
          sessionDirNewestMs: 0,
          extraBytes: 0,
          extraNewestMs: 0,
          subagentCount: 0,
          legacyAgents: [],
          parsed,
        };
        sessions.set(key, catalogSession);
        const lookup = sessionIdLookupKey("codex", canonicalId);
        bySessionId.set(lookup, [...(bySessionId.get(lookup) ?? []), key]);
      } else {
        const key = sessionKey(item.root.id, "conversations", item.sessionId, "antigravity");
        let brainBytes = 0;
        let brainNewestMs = 0;
        if (item.brainDir) {
          try {
            const size = await treeSize(item.brainDir);
            brainBytes = size.bytes;
            brainNewestMs = size.newestMs;
          } catch {
            warn("unreadable_dir", item.brainDir);
          }
        }
        const primary: FileInfo = item.dbFile ?? item.transcriptFile ?? { path: item.brainDir ?? join(item.root.real, "conversations", `${item.sessionId}.db`), size: 0, mtimeMs: brainNewestMs };
        const extraBytes = (item.annotationFile?.size ?? 0) + (item.presenceFile?.size ?? 0);
        const extraNewestMs = Math.max(item.annotationFile?.mtimeMs ?? 0, item.presenceFile?.mtimeMs ?? 0, item.transcriptFile?.mtimeMs ?? 0);
        const normalized = normalizeCwd(parsed.cwd);
        const fallbackLabel = item.meta?.projectId || "antigravity";
        const catalogSession: CatalogSession = {
          key,
          provider: "antigravity",
          root: item.root,
          projectDir: "conversations",
          projectKey: normalized ? `cwd:${normalized}` : `dir:antigravity/${item.root.id}/${fallbackLabel}`,
          projectLabel: normalized || fallbackLabel,
          projectPath: join(item.root.real, "conversations"),
          sessionId: item.sessionId,
          transcript: primary,
          antigravityTranscriptPath: item.transcriptFile?.path ?? null,
          sessionDir: item.brainDir,
          sessionDirBytes: brainBytes,
          sessionDirNewestMs: brainNewestMs,
          extraBytes,
          extraNewestMs,
          subagentCount: extraSubagents,
          legacyAgents: [],
          parsed,
        };
        sessions.set(key, catalogSession);
        const lookup = sessionIdLookupKey("antigravity", item.sessionId);
        bySessionId.set(lookup, [...(bySessionId.get(lookup) ?? []), key]);
      }
    }

    // For Claude sessions without an explicit cwd (e.g. empty summary-only transcripts), inherit
    // the majority cwd of their project directory so they stay grouped with their project.
    for (const session of claudeRaw) {
      if (session.parsed.cwd) continue;
      const votes = claudeDirVotes.get(`${session.root.id}/${session.projectDir}`);
      if (!votes) continue;
      const best = [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      if (best) {
        session.projectKey = `cwd:${best[0]}`;
        session.projectLabel = best[0];
      }
    }

    return { roots, sessions, bySessionId, warnings };
  }
}
