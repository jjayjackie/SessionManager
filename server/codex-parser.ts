import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { clip } from "../shared/format";
import { emptyTranscript, MAX_SEARCH_TEXT, type ParsedTranscript, type PreviewMessage } from "./parser";
import { querySqliteReadOnly } from "./sqlite";

/**
 * Streams a Codex CLI rollout JSONL (`sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl` or
 * `archived_sessions/rollout-*.jsonl`) and enriches metadata from `session_index.jsonl` and
 * read-only `state_*.sqlite` when present.
 */

const MAX_PROMPT = 400;
const UUID_SUFFIX = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function extractCodexSessionId(filename: string): string {
  const match = UUID_SUFFIX.exec(filename);
  if (match) return match[1];
  return filename.replace(/\.jsonl$/, "");
}

function extractCodexContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = object(block);
    if ((b.type === "input_text" || b.type === "output_text" || b.type === "text") && typeof b.text === "string") {
      parts.push(b.text);
    }
  }
  return parts.join("\n");
}

function isSyntheticCodexPrompt(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed === "" ||
    /^<(environment_context|INSTRUCTIONS|user_instructions|permissions instructions|collaboration_mode|skills_instructions|turn_aborted|system-reminder)>/i.test(trimmed) ||
    trimmed.startsWith("# AGENTS.md instructions")
  );
}

class SearchBuffer {
  private parts: string[] = [];
  private size = 0;
  add(text: string): void {
    if (!text || this.size >= MAX_SEARCH_TEXT) return;
    const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
    if (!normalized) return;
    const piece = normalized.slice(0, MAX_SEARCH_TEXT - this.size);
    this.parts.push(piece);
    this.size += piece.length;
  }
  toString(): string {
    return this.parts.join("\n");
  }
}

export interface CodexThreadMeta {
  title: string;
  cwd: string;
  gitBranch: string;
  cliVersion: string;
  model: string;
  firstUserMessage: string;
}

export class CodexRolloutAccumulator {
  readonly result = emptyTranscript();
  private readonly sessionIds = new Set<string>();
  private readonly models = new Set<string>();
  private readonly search = new SearchBuffer();
  private responseUserMessages = 0;
  private responseAssistantMessages = 0;
  private eventUserMessages = 0;
  private eventAssistantMessages = 0;
  private eventFirstPrompt = "";

  line(raw: string): void {
    if (!raw.trim()) return;
    this.result.lines += 1;
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      record = parsed as Record<string, unknown>;
    } catch {
      this.result.badLines += 1;
      return;
    }
    this.record(record);
  }

  private bumpTime(ts: string): void {
    if (!ts || Number.isNaN(Date.parse(ts))) return;
    const r = this.result;
    if (!r.startedAt || ts < r.startedAt) r.startedAt = ts;
    if (!r.endedAt || ts > r.endedAt) r.endedAt = ts;
  }

  private record(o: Record<string, unknown>): void {
    const r = this.result;
    const type = str(o.type);
    this.bumpTime(str(o.timestamp));
    const payload = object(o.payload);

    if (type === "session_meta") {
      const id = str(payload.session_id) || str(payload.id);
      if (id) this.sessionIds.add(id);
      if (!r.cwd && str(payload.cwd)) r.cwd = str(payload.cwd);
      if (str(payload.cli_version)) r.version = str(payload.cli_version);
      const git = object(payload.git);
      if (str(git.branch)) r.gitBranch = str(git.branch);
      if (str(payload.model)) this.models.add(str(payload.model));
      this.bumpTime(str(payload.timestamp));
      return;
    }

    if (type === "turn_context") {
      if (!r.cwd && str(payload.cwd)) r.cwd = str(payload.cwd);
      if (str(payload.model)) this.models.add(str(payload.model));
      return;
    }

    if (type === "response_item") {
      if (str(payload.type) !== "message") return;
      const role = str(payload.role);
      const text = extractCodexContent(payload.content);
      if (!text) return;
      if (role === "user") {
        if (isSyntheticCodexPrompt(text)) return;
        this.responseUserMessages += 1;
        if (!r.firstPrompt) r.firstPrompt = clip(text, MAX_PROMPT);
        r.lastPrompt = clip(text, MAX_PROMPT);
        this.search.add(text);
      } else if (role === "assistant") {
        this.responseAssistantMessages += 1;
        this.search.add(text);
      }
      return;
    }

    if (type === "event_msg") {
      const sub = str(payload.type);
      if (sub === "user_message") {
        const text = str(payload.message);
        if (text && !isSyntheticCodexPrompt(text)) {
          this.eventUserMessages += 1;
          if (!this.eventFirstPrompt) this.eventFirstPrompt = clip(text, MAX_PROMPT);
          if (!r.lastPrompt) r.lastPrompt = clip(text, MAX_PROMPT);
          this.search.add(text);
        }
      } else if (sub === "agent_message") {
        const text = str(payload.message);
        if (text) {
          this.eventAssistantMessages += 1;
          this.search.add(text);
        }
      } else if (sub === "thread_name" || sub === "session_renamed") {
        const title = str(payload.thread_name) || str(payload.name) || str(payload.title);
        if (title) r.customTitle = title;
      }
    }
  }

  finish(meta?: CodexThreadMeta): ParsedTranscript {
    const r = this.result;
    r.sessionIds = [...this.sessionIds];
    r.userMessages = this.responseUserMessages || this.eventUserMessages;
    r.assistantMessages = this.responseAssistantMessages || this.eventAssistantMessages;
    if (!r.firstPrompt && this.eventFirstPrompt) r.firstPrompt = this.eventFirstPrompt;
    if (meta) {
      if (meta.title && !r.customTitle) r.customTitle = meta.title;
      if (meta.cwd && !r.cwd) r.cwd = meta.cwd;
      if (meta.gitBranch && !r.gitBranch) r.gitBranch = meta.gitBranch;
      if (meta.cliVersion && !r.version) r.version = meta.cliVersion;
      if (meta.model) this.models.add(meta.model);
      if (meta.firstUserMessage && !r.firstPrompt) r.firstPrompt = clip(meta.firstUserMessage, MAX_PROMPT);
    }
    r.models = [...this.models].sort();
    this.search.add([r.customTitle, r.firstPrompt, r.lastPrompt].filter(Boolean).join("\n"));
    r.searchText = this.search.toString();
    return r;
  }
}

export async function parseCodexRollout(path: string, meta?: CodexThreadMeta): Promise<ParsedTranscript> {
  const accumulator = new CodexRolloutAccumulator();
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) accumulator.line(line);
  } finally {
    lines.close();
    stream.destroy();
  }
  return accumulator.finish(meta);
}

export async function readCodexPreview(path: string, head = 4, tail = 4, max = 600): Promise<PreviewMessage[]> {
  const responseFirst: PreviewMessage[] = [];
  const responseLast: PreviewMessage[] = [];
  const eventFirst: PreviewMessage[] = [];
  const eventLast: PreviewMessage[] = [];
  const push = (first: PreviewMessage[], last: PreviewMessage[], message: PreviewMessage) => {
    if (first.length < head) first.push(message);
    else {
      last.push(message);
      if (last.length > tail) last.shift();
    }
  };

  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      // Fast-skip large non-conversational lines (tool calls, diffs, shell output) before JSON.parse.
      if (!line.includes("response_item") && !line.includes("event_msg")) continue;
      if (!line.includes("message") && !line.includes("user_message") && !line.includes("agent_message")) continue;
      let o: Record<string, unknown>;
      try {
        o = object(JSON.parse(line));
      } catch {
        continue;
      }
      const type = str(o.type);
      const ts = str(o.timestamp) || null;
      const payload = object(o.payload);
      if (type === "response_item" && str(payload.type) === "message") {
        const role = str(payload.role);
        if (role !== "user" && role !== "assistant") continue;
        const text = extractCodexContent(payload.content);
        if (!text || (role === "user" && isSyntheticCodexPrompt(text))) continue;
        push(responseFirst, responseLast, { role, text: clip(text, max), timestamp: ts });
      } else if (type === "event_msg") {
        const sub = str(payload.type);
        if (sub === "user_message") {
          const text = str(payload.message);
          if (text && !isSyntheticCodexPrompt(text)) push(eventFirst, eventLast, { role: "user", text: clip(text, max), timestamp: ts });
        } else if (sub === "agent_message") {
          const text = str(payload.message);
          if (text) push(eventFirst, eventLast, { role: "assistant", text: clip(text, max), timestamp: ts });
        }
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return responseFirst.length ? [...responseFirst, ...responseLast] : [...eventFirst, ...eventLast];
}

async function latestCodexStateDb(rootReal: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(rootReal);
  } catch {
    return null;
  }
  let bestVersion = -1;
  let bestName: string | null = null;
  for (const name of names) {
    const match = /^state_(\d+)\.sqlite$/.exec(name);
    if (!match) continue;
    const version = Number(match[1]);
    if (version > bestVersion) {
      bestVersion = version;
      bestName = name;
    }
  }
  return bestName ? join(rootReal, bestName) : null;
}

/**
 * Reads optional Codex thread metadata from `state_<n>.sqlite` (read-only) merged with
 * `<root>/session_index.jsonl`, giving accurate titles, branches, models, and cwds even when
 * `session_index.jsonl` is empty.
 */
export async function readCodexMetadata(rootReal: string): Promise<Map<string, CodexThreadMeta>> {
  const result = new Map<string, CodexThreadMeta>();
  const stateDb = await latestCodexStateDb(rootReal);
  if (stateDb) {
    const rows =
      (await querySqliteReadOnly(stateDb, "SELECT id, title, name, cwd, git_branch, cli_version, model, first_user_message FROM threads")) ??
      (await querySqliteReadOnly(stateDb, "SELECT id, title, cwd, git_branch, cli_version, first_user_message FROM threads"));
    if (rows) {
      for (const row of rows) {
        const id = str(row.id);
        if (!id) continue;
        result.set(id, {
          title: str(row.name) || str(row.title),
          cwd: str(row.cwd),
          gitBranch: str(row.git_branch),
          cliVersion: str(row.cli_version),
          model: str(row.model),
          firstUserMessage: str(row.first_user_message),
        });
      }
    }
  }

  let raw: string;
  try {
    raw = await readFile(join(rootReal, "session_index.jsonl"), "utf8");
  } catch {
    return result;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const o = object(JSON.parse(line));
      const id = str(o.id);
      const name = str(o.thread_name) || str(o.title);
      if (!id || !name) continue;
      const existing = result.get(id);
      result.set(id, {
        title: name,
        cwd: existing?.cwd ?? "",
        gitBranch: existing?.gitBranch ?? "",
        cliVersion: existing?.cliVersion ?? "",
        model: existing?.model ?? "",
        firstUserMessage: existing?.firstUserMessage ?? "",
      });
    } catch {
      // Ignore malformed lines in the index.
    }
  }
  return result;
}
