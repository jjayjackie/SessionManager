import { join } from "node:path";
import {
  PROVIDERS,
  type DetailOutput,
  type ListOutput,
  type ListQuery,
  type OperationOutput,
  type OperationResult,
  type PreviewItem,
  type PreviewOutput,
  type ProjectSummary,
  type ProviderCounts,
  type ProviderId,
  type ReasonCode,
  type SessionState,
  type SessionSummary,
  type TrashListOutput,
} from "../shared/schema";
import { clip } from "../shared/format";
import { readAntigravityPreview } from "./antigravity-parser";
import { planSession } from "./artifacts";
import { readCodexPreview } from "./codex-parser";
import { codexLockMtime, liveSessionIds, paseoAgentRunning, paseoAgents, processAlive, type AliveCheck, type PaseoAgent } from "./live";
import { readPreview } from "./parser";
import { discoverRoots, paseoHome, type AgentRoot } from "./roots";
import { Scanner, sessionIdLookupKey, type CatalogSession, type ScanResult } from "./scanner";
import { removeFromAntigravityIndex, removeFromCodexIndex, removeFromIndex } from "./sessions-index";
import { OperationError, Trash } from "./trash";
import { UnsafePathError } from "./safety";

export const RECENT_MS = 90_000;
const STALE_MS = 15_000;
const FIRST_WAIT_MS = 4_000;

export interface ManagerOptions {
  /** Agent data directories; defaults to discovery from the daemon environment and Paseo config. */
  roots?: () => Promise<AgentRoot[]>;
  paseoHome?: string;
  trashDir?: string;
  now?: () => number;
  alive?: AliveCheck;
  recentMs?: number;
}

interface Catalog extends ScanResult {
  scannedAt: number;
  live: Map<string, Set<string>>;
  agents: Map<string, PaseoAgent>;
}

export function defaultTrashDir(home: string): string {
  return join(home, "plugin-data", "session-manager", "trash");
}

function reasonOf(error: unknown): ReasonCode {
  if (error instanceof OperationError) return error.reason;
  if (error instanceof UnsafePathError) return "unsafe_path";
  return "io_error";
}

function sortValue(session: SessionSummary, sort: ListQuery["sort"]): number | string {
  switch (sort) {
    case "started":
      return session.startedAt ?? "";
    case "size":
      return session.bytes;
    case "messages":
      return session.userMessages + session.assistantMessages;
    case "title":
      return session.title.toLocaleLowerCase();
    default:
      return session.updatedAt;
  }
}

/** Splits a query into lowercase terms; every term must match (AND). */
export function searchTerms(search: string): string[] {
  return search.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 12);
}

function snippetFor(text: string, term: string): string | null {
  const index = text.indexOf(term);
  if (index < 0) return null;
  const start = Math.max(0, index - 60);
  return `${start > 0 ? "…" : ""}${clip(text.slice(start, index + term.length + 100), 180)}`;
}

function emptyProviderCounts(): ProviderCounts {
  return { claude: 0, codex: 0, antigravity: 0 };
}

/**
 * One instance per plugin installation, i.e. per daemon host. Reads run against the latest
 * catalog; mutations run one at a time and re-verify each session on disk before touching it.
 */
export class SessionManager {
  private readonly scanner = new Scanner();
  private readonly trash: Trash;
  private readonly home: string;
  private readonly now: () => number;
  private readonly alive: AliveCheck;
  private readonly recentMs: number;
  private readonly rootsSource: () => Promise<AgentRoot[]>;
  private catalog: Catalog | null = null;
  private scanPromise: Promise<void> | null = null;
  private epoch = 0;
  private progress = { done: 0, total: 0 };
  private lock: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private scanFailed = false;

  constructor(options: ManagerOptions = {}) {
    this.home = options.paseoHome ?? paseoHome();
    this.trash = new Trash(options.trashDir ?? defaultTrashDir(this.home), options.now);
    this.now = options.now ?? Date.now;
    this.alive = options.alive ?? processAlive;
    this.recentMs = options.recentMs ?? RECENT_MS;
    this.rootsSource = options.roots ?? (() => discoverRoots({ paseoHome: this.home }));
  }

  dispose(): void {
    this.disposed = true;
  }

  get trashPath(): string {
    return this.trash.dir;
  }

  /** Starts a scan unless one is running. A mutation during a scan makes it scan again. */
  private ensureScan(): Promise<void> {
    if (!this.scanPromise) {
      const run = async () => {
        for (;;) {
          const epoch = this.epoch;
          const roots = await this.rootsSource();
          const result = await this.scanner.scan(roots, (done, total) => {
            this.progress = { done, total };
          });
          const live = new Map<string, Set<string>>();
          for (const root of roots) live.set(root.id, await liveSessionIds(root.real, root.provider, this.alive));
          const agents = await paseoAgents(this.home);
          if (epoch === this.epoch || this.disposed) {
            this.catalog = { ...result, scannedAt: this.now(), live, agents };
            return;
          }
        }
      };
      this.scanPromise = run()
        .then(() => {
          this.scanFailed = false;
        })
        .catch((error: unknown) => {
          this.scanFailed = true;
          throw error;
        })
        .finally(() => {
          this.scanPromise = null;
        });
    }
    return this.scanPromise;
  }

  private async fresh(): Promise<Catalog> {
    await this.ensureScan();
    if (!this.catalog) throw new OperationError("io_error", "Scan produced no catalog");
    return this.catalog;
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = this.lock.then(task, task);
    this.lock = next.catch(() => undefined);
    return next;
  }

  private stateOf(session: CatalogSession, catalog: Catalog): SessionState {
    if (catalog.live.get(session.root.id)?.has(session.sessionId) || paseoAgentRunning(catalog.agents.get(session.sessionId))) return "running";
    const newest = Math.max(
      session.transcript.mtimeMs,
      session.sessionDirNewestMs,
      session.extraNewestMs,
      ...session.legacyAgents.map((file) => file.mtimeMs),
    );
    return this.now() - newest < this.recentMs ? "recent" : "idle";
  }

  private summarize(session: CatalogSession, catalog: Catalog, snippet: string | null = null): SessionSummary {
    const p = session.parsed;
    const titleSource = p.customTitle ? "custom" : p.aiTitle ? "ai" : p.summary ? "summary" : p.firstPrompt ? "prompt" : "none";
    const title = p.customTitle || p.aiTitle || p.summary || p.firstPrompt || p.lastPrompt;
    const agent = catalog.agents.get(session.sessionId);
    const newestMs = Math.max(session.transcript.mtimeMs, session.sessionDirNewestMs, session.extraNewestMs);
    const mtime = new Date(newestMs || this.now()).toISOString();
    const health = p.badLines > 0 ? "damaged" : p.userMessages + p.assistantMessages === 0 ? "empty" : "ok";
    const lookup = sessionIdLookupKey(session.provider, session.sessionId);
    return {
      key: session.key,
      provider: session.provider,
      sessionId: session.sessionId,
      projectKey: session.projectKey,
      rootId: session.root.id,
      title: clip(title || "", 200),
      titleSource,
      firstPrompt: p.firstPrompt,
      cwd: p.cwd,
      gitBranch: p.gitBranch,
      startedAt: p.startedAt,
      updatedAt: p.endedAt && p.endedAt > mtime ? p.endedAt : mtime,
      userMessages: p.userMessages,
      assistantMessages: p.assistantMessages,
      bytes: session.transcript.size + session.sessionDirBytes + session.extraBytes + session.legacyAgents.reduce((sum, file) => sum + file.size, 0),
      subagentCount: session.subagentCount,
      state: this.stateOf(session, catalog),
      health,
      badLines: p.badLines,
      duplicateId: (catalog.bySessionId.get(lookup)?.length ?? 0) > 1,
      paseo: agent ? { agentId: agent.agentId, title: agent.title, archived: agent.archived } : null,
      snippet,
    };
  }

  async list(query: ListQuery): Promise<ListOutput> {
    if (query.refresh || !this.catalog || this.now() - this.catalog.scannedAt > STALE_MS) void this.ensureScan().catch(() => undefined);
    if (this.scanPromise && !this.catalog) {
      await Promise.race([this.scanPromise.catch(() => undefined), new Promise((resolve) => setTimeout(resolve, FIRST_WAIT_MS).unref?.())]);
    }
    const catalog = this.catalog;
    const scanning = this.scanPromise ? { ...this.progress } : null;
    const trash = await this.trash.list();
    if (!catalog) {
      return {
        roots: [],
        projects: [],
        items: [],
        total: 0,
        page: 0,
        pageSize: query.pageSize,
        scannedAt: null,
        scanning,
        stats: {
          sessions: 0,
          projects: 0,
          bytes: 0,
          active: 0,
          damaged: 0,
          trashEntries: trash.entries.length,
          trashBytes: trash.bytes,
          byProvider: emptyProviderCounts(),
        },
        warnings: this.scanFailed ? [{ code: "scan_failed", path: "" }] : [],
      };
    }

    const all = [...catalog.sessions.values()].map((session) => ({ session, summary: this.summarize(session, catalog) }));
    const byProvider = emptyProviderCounts();
    for (const { summary } of all) byProvider[summary.provider] += 1;

    const inProvider = query.provider === "all" ? all : all.filter(({ summary }) => summary.provider === query.provider);

    const terms = searchTerms(query.search);
    const matchesFilters = ({ session, summary }: (typeof all)[number]): boolean => {
      if (query.state === "active" && summary.state === "idle") return false;
      if (query.state === "idle" && summary.state !== "idle") return false;
      if (query.health !== "all" && summary.health !== query.health) return false;
      if (query.origin === "paseo" && !summary.paseo) return false;
      if (query.origin === "native" && summary.paseo) return false;
      if (!terms.length) return true;
      const haystack = `${session.parsed.searchText}\n${summary.title.toLowerCase()}\n${summary.cwd.toLowerCase()}\n${session.sessionId.toLowerCase()}\n${summary.gitBranch.toLowerCase()}\n${summary.provider}\n${summary.paseo?.title.toLowerCase() ?? ""}`;
      return terms.every((term) => haystack.includes(term));
    };

    const filtered = inProvider.filter(matchesFilters);
    const matchingByProject = new Map<string, number>();
    for (const { summary } of filtered) matchingByProject.set(summary.projectKey, (matchingByProject.get(summary.projectKey) ?? 0) + 1);

    const inProject = query.projectKey ? filtered.filter(({ summary }) => summary.projectKey === query.projectKey) : filtered;
    const direction = query.direction === "asc" ? 1 : -1;
    inProject.sort((a, b) => {
      const x = sortValue(a.summary, query.sort);
      const y = sortValue(b.summary, query.sort);
      return (x < y ? -1 : x > y ? 1 : a.summary.key.localeCompare(b.summary.key)) * direction;
    });

    const pages = Math.max(1, Math.ceil(inProject.length / query.pageSize));
    const page = Math.min(query.page, pages - 1);
    const items = inProject.slice(page * query.pageSize, (page + 1) * query.pageSize).map(({ session, summary }) => {
      if (!terms.length) return summary;
      const text = session.parsed.searchText;
      return { ...summary, snippet: snippetFor(text, terms[0]) };
    });

    // Build unified projects across the active provider slice.
    const projectMap = new Map<string, { path: string; providers: Set<ProviderId>; sessions: number; bytes: number; updatedAt: string | null }>();
    for (const { session, summary } of inProvider) {
      let group = projectMap.get(summary.projectKey);
      if (!group) {
        group = { path: session.projectLabel, providers: new Set(), sessions: 0, bytes: 0, updatedAt: null };
        projectMap.set(summary.projectKey, group);
      }
      group.providers.add(summary.provider);
      group.sessions += 1;
      group.bytes += summary.bytes;
      if (!group.updatedAt || summary.updatedAt > group.updatedAt) group.updatedAt = summary.updatedAt;
    }

    const projects: ProjectSummary[] = [...projectMap.entries()].map(([key, group]) => ({
      key,
      path: group.path,
      providers: PROVIDERS.filter((provider) => group.providers.has(provider)),
      sessions: group.sessions,
      matching: matchingByProject.get(key) ?? 0,
      bytes: group.bytes,
      updatedAt: group.updatedAt,
    }));
    projects.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.path.localeCompare(b.path));

    const allProjectKeys = new Set(all.map(({ summary }) => summary.projectKey));

    return {
      roots: catalog.roots.map((root) => ({
        id: root.id,
        provider: root.provider,
        path: root.real,
        isDefault: root.isDefault,
        source: root.source,
        available: root.available,
        sessions: all.filter((entry) => entry.session.root.id === root.id).length,
      })),
      projects,
      items,
      total: inProject.length,
      page,
      pageSize: query.pageSize,
      stats: {
        sessions: all.length,
        projects: allProjectKeys.size,
        bytes: all.reduce((sum, entry) => sum + entry.summary.bytes, 0),
        active: all.filter((entry) => entry.summary.state !== "idle").length,
        damaged: all.filter((entry) => entry.summary.health === "damaged").length,
        trashEntries: trash.entries.length,
        trashBytes: trash.bytes,
        byProvider,
      },
      scannedAt: new Date(catalog.scannedAt).toISOString(),
      scanning,
      warnings: this.scanFailed ? [{ code: "scan_failed", path: "" }, ...catalog.warnings] : catalog.warnings,
    };
  }

  async detail(key: string): Promise<DetailOutput> {
    const catalog = this.catalog ?? (await this.fresh());
    const session = catalog.sessions.get(key);
    if (!session) throw new OperationError("not_found");
    const plan = await planSession(session, catalog);
    const summary = this.summarize(session, catalog);
    const related: DetailOutput["related"] = [];
    if (session.parsed.uuids.size > 0) {
      for (const other of catalog.sessions.values()) {
        if (other.key === key || other.root.id !== session.root.id) continue;
        let shared = 0;
        for (const uuid of session.parsed.uuids) if (other.parsed.uuids.has(uuid)) shared += 1;
        if (shared) related.push({ key: other.key, title: this.summarize(other, catalog).title, shared });
      }
      related.sort((a, b) => b.shared - a.shared);
    }
    let preview: DetailOutput["preview"] = [];
    try {
      if (session.provider === "claude") {
        preview = await readPreview(session.transcript.path);
      } else if (session.provider === "codex") {
        preview = await readCodexPreview(session.transcript.path);
      } else if (session.antigravityTranscriptPath) {
        preview = await readAntigravityPreview(session.antigravityTranscriptPath);
      }
    } catch {
      // Shown as an empty preview.
    }
    const toInfo = (file: (typeof plan.files)[number]) => ({ path: file.rel, kind: file.kind, bytes: file.bytes });
    const lookup = sessionIdLookupKey(session.provider, session.sessionId);
    const nativeLive = catalog.live.get(session.root.id)?.has(session.sessionId);
    const paseoLive = paseoAgentRunning(catalog.agents.get(session.sessionId));
    const blocked: ReasonCode | null = nativeLive ? "running" : paseoLive ? "paseo_running" : summary.state === "recent" ? "recent" : null;
    return {
      session: summary,
      rootPath: session.root.real,
      isDefaultRoot: session.root.isDefault,
      transcriptPath: session.antigravityTranscriptPath ?? session.transcript.path,
      version: session.parsed.version,
      models: session.parsed.models,
      files: plan.files.map(toInfo),
      keptShared: plan.keptShared.map(toInfo),
      duplicates: (catalog.bySessionId.get(lookup) ?? []).filter((other) => other !== key),
      related: related.slice(0, 20),
      duplicateUuids: session.parsed.duplicateUuids,
      preview,
      blocked,
    };
  }

  /** Re-reads liveness for one session right before it is touched. */
  private async blockedNow(session: CatalogSession): Promise<ReasonCode | null> {
    if ((await liveSessionIds(session.root.real, session.provider, this.alive)).has(session.sessionId)) return "running";
    if (paseoAgentRunning((await paseoAgents(this.home)).get(session.sessionId))) return "paseo_running";
    if (session.provider === "codex") {
      const lockMs = await codexLockMtime(session.root.real, session.sessionId);
      if (lockMs > 0 && this.recentlyWritten(lockMs)) return "recent";
    }
    return null;
  }

  private recentlyWritten(newestMs: number): boolean {
    return this.now() - newestMs < this.recentMs;
  }

  async previewDelete(keys: string[]): Promise<PreviewOutput> {
    const catalog = await this.fresh();
    const items: PreviewItem[] = [];
    for (const key of [...new Set(keys)]) {
      const session = catalog.sessions.get(key);
      if (!session) {
        items.push({ key, provider: "claude", title: "", fingerprint: "", files: [], bytes: 0, blocked: "not_found" });
        continue;
      }
      const plan = await planSession(session, catalog);
      const newest = Math.max(0, ...plan.files.map((file) => file.newestMs));
      const blocked = (await this.blockedNow(session)) ?? (this.recentlyWritten(newest) ? "recent" : null);
      items.push({
        key,
        provider: session.provider,
        title: this.summarize(session, catalog).title,
        fingerprint: plan.fingerprint,
        files: plan.files.map((file) => ({ path: file.rel, kind: file.kind, bytes: file.bytes })),
        bytes: plan.files.reduce((sum, file) => sum + file.bytes, 0),
        blocked,
      });
    }
    const deletable = items.filter((item) => !item.blocked);
    return {
      items,
      deletable: deletable.length,
      files: deletable.reduce((sum, item) => sum + item.files.length, 0),
      bytes: deletable.reduce((sum, item) => sum + item.bytes, 0),
    };
  }

  async deleteSessions(items: { key: string; fingerprint: string }[]): Promise<OperationOutput> {
    return this.exclusive(async () => {
      const results: OperationResult[] = [];
      const seen = new Set<string>();
      // A fresh catalog: another client may have deleted some of these already.
      const catalog = await this.fresh();
      for (const { key, fingerprint } of items) {
        if (seen.has(key)) continue;
        seen.add(key);
        const session = catalog.sessions.get(key);
        if (!session) {
          results.push({ id: key, ok: false, reason: "not_found", trashId: null });
          continue;
        }
        try {
          const plan = await planSession(session, catalog);
          if (plan.fingerprint !== fingerprint) throw new OperationError("changed");
          const blocked = await this.blockedNow(session);
          if (blocked) throw new OperationError(blocked);
          if (this.recentlyWritten(Math.max(0, ...plan.files.map((file) => file.newestMs)))) throw new OperationError("recent");
          const summary = this.summarize(session, catalog);
          const trashId = await this.trash.moveIn(
            {
              key,
              provider: session.provider,
              sessionId: session.sessionId,
              title: summary.title,
              cwd: summary.cwd,
              root: session.root,
              projectDir: session.projectDir,
            },
            plan.files,
            async () => {
              if (session.provider === "claude") return (await removeFromIndex(session.projectPath, session.sessionId)).removed;
              if (session.provider === "codex") return (await removeFromCodexIndex(session.root.real, session.sessionId)).removed;
              return (await removeFromAntigravityIndex(session.root.real, session.sessionId)).removed;
            },
          );
          this.epoch += 1;
          catalog.sessions.delete(key);
          const lookup = sessionIdLookupKey(session.provider, session.sessionId);
          const siblings = (catalog.bySessionId.get(lookup) ?? []).filter((other) => other !== key);
          if (siblings.length) catalog.bySessionId.set(lookup, siblings);
          else catalog.bySessionId.delete(lookup);
          results.push({ id: key, ok: true, reason: null, trashId });
        } catch (error) {
          results.push({ id: key, ok: false, reason: reasonOf(error), trashId: null });
        }
      }
      this.epoch += 1;
      await this.ensureScan();
      return { results };
    });
  }

  async listTrash(): Promise<TrashListOutput> {
    const { entries, bytes } = await this.trash.list();
    return { entries, bytes, path: this.trash.dir };
  }

  async restore(trashIds: string[]): Promise<OperationOutput> {
    return this.exclusive(async () => {
      const roots = await this.rootsSource();
      const results: OperationResult[] = [];
      for (const trashId of [...new Set(trashIds)]) {
        try {
          await this.trash.restore(trashId, roots);
          results.push({ id: trashId, ok: true, reason: null, trashId });
        } catch (error) {
          results.push({ id: trashId, ok: false, reason: reasonOf(error), trashId });
        }
      }
      this.epoch += 1;
      await this.ensureScan();
      return { results };
    });
  }

  async purge(trashIds: string[], all: boolean): Promise<OperationOutput> {
    return this.exclusive(async () => {
      const ids = all ? await this.trash.ids() : [...new Set(trashIds)];
      const results: OperationResult[] = [];
      for (const trashId of ids) {
        try {
          await this.trash.purge(trashId);
          results.push({ id: trashId, ok: true, reason: null, trashId });
        } catch (error) {
          results.push({ id: trashId, ok: false, reason: reasonOf(error), trashId });
        }
      }
      return { results };
    });
  }
}
