import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";
import { clip } from "../shared/format";

/**
 * Reads one Claude Code JSONL transcript in a single streaming pass. Unknown record types are
 * ignored, so new Claude versions keep working; unparseable lines are counted, never fatal.
 */

/** Conversational text kept per session for full-text search. Tool output is not indexed. */
export const MAX_SEARCH_TEXT = 256 * 1024;
const MAX_PROMPT = 400;

export interface ParsedTranscript {
  sessionIds: string[];
  cwd: string;
  gitBranch: string;
  version: string;
  models: string[];
  customTitle: string;
  aiTitle: string;
  summary: string;
  lastPrompt: string;
  firstPrompt: string;
  userMessages: number;
  assistantMessages: number;
  startedAt: string | null;
  endedAt: string | null;
  badLines: number;
  lines: number;
  /** Every line is a sidechain (subagent) message. */
  sidechainOnly: boolean;
  uuids: Set<string>;
  duplicateUuids: number;
  /** Lowercased title, prompts, and assistant replies, capped at MAX_SEARCH_TEXT. */
  searchText: string;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Text blocks of a message `content`, skipping tool results, images, and thinking. */
export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const b = object(block);
    if (b.type === "text" && typeof b.text === "string") parts.push(b.text);
  }
  return parts.join("\n");
}

/** Slash-command wrappers, local command output, and injected reminders are not prompts. */
export function isSyntheticPrompt(text: string): boolean {
  const trimmed = text.trimStart();
  return (
    trimmed === "" ||
    /^<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat|system-reminder|bash-input|bash-stdout|bash-stderr|user-memory-input)>/.test(trimmed) ||
    trimmed.startsWith("Caveat: The messages below were generated")
  );
}

class SearchBuffer {
  private parts: string[] = [];
  private size = 0;
  add(text: string): void {
    if (!text || this.size >= MAX_SEARCH_TEXT) return;
    const piece = text.slice(0, MAX_SEARCH_TEXT - this.size).toLowerCase();
    this.parts.push(piece);
    this.size += piece.length;
  }
  toString(): string {
    return this.parts.join("\n");
  }
}

export function emptyTranscript(): ParsedTranscript {
  return {
    sessionIds: [], cwd: "", gitBranch: "", version: "", models: [], customTitle: "", aiTitle: "", summary: "",
    lastPrompt: "", firstPrompt: "", userMessages: 0, assistantMessages: 0, startedAt: null, endedAt: null,
    badLines: 0, lines: 0, sidechainOnly: false, uuids: new Set(), duplicateUuids: 0, searchText: "",
  };
}

/** Feeds one parsed JSON record into the accumulator. Exported for tests. */
export class TranscriptAccumulator {
  readonly result = emptyTranscript();
  private readonly sessionIds = new Set<string>();
  private readonly models = new Set<string>();
  private readonly search = new SearchBuffer();
  private messages = 0;
  private sidechainMessages = 0;

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

  private record(o: Record<string, unknown>): void {
    const r = this.result;
    const type = str(o.type);
    const sessionId = str(o.sessionId);
    if (sessionId) this.sessionIds.add(sessionId);
    if (!r.cwd && str(o.cwd)) r.cwd = str(o.cwd);
    if (str(o.gitBranch)) r.gitBranch = str(o.gitBranch);
    if (str(o.version)) r.version = str(o.version);
    const timestamp = str(o.timestamp);
    if (timestamp && !Number.isNaN(Date.parse(timestamp))) {
      if (!r.startedAt || timestamp < r.startedAt) r.startedAt = timestamp;
      if (!r.endedAt || timestamp > r.endedAt) r.endedAt = timestamp;
    }
    const uuid = str(o.uuid);
    if (uuid) {
      if (r.uuids.has(uuid)) r.duplicateUuids += 1;
      else r.uuids.add(uuid);
    }
    switch (type) {
      case "custom-title":
        if (str(o.customTitle)) r.customTitle = str(o.customTitle);
        return;
      case "ai-title":
        if (str(o.aiTitle)) r.aiTitle = str(o.aiTitle);
        return;
      case "summary":
        if (str(o.summary)) r.summary = str(o.summary);
        return;
      case "last-prompt":
        if (str(o.lastPrompt)) r.lastPrompt = str(o.lastPrompt);
        return;
      case "user":
      case "assistant":
        break;
      default:
        return;
    }
    this.messages += 1;
    if (o.isSidechain === true) this.sidechainMessages += 1;
    if (o.isMeta === true) return;
    const message = object(o.message);
    const text = messageText(message.content);
    if (type === "user") {
      // Tool results arrive as user records with no text blocks.
      if (!text) return;
      r.userMessages += 1;
      if (!isSyntheticPrompt(text)) {
        if (!r.firstPrompt && o.isSidechain !== true) r.firstPrompt = clip(text, MAX_PROMPT);
        this.search.add(text);
      }
      return;
    }
    r.assistantMessages += 1;
    const model = str(message.model);
    if (model && model !== "<synthetic>") this.models.add(model);
    this.search.add(text);
  }

  finish(): ParsedTranscript {
    const r = this.result;
    r.sessionIds = [...this.sessionIds];
    r.models = [...this.models].sort();
    r.sidechainOnly = this.messages > 0 && this.sidechainMessages === this.messages;
    this.search.add([r.customTitle, r.aiTitle, r.summary, r.lastPrompt].filter(Boolean).join("\n"));
    r.searchText = this.search.toString();
    return r;
  }
}

export async function parseTranscript(path: string): Promise<ParsedTranscript> {
  const accumulator = new TranscriptAccumulator();
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) accumulator.line(line);
  } finally {
    lines.close();
    stream.destroy();
  }
  return accumulator.finish();
}

/** The `sessionId` of the first record that has one; used to attach legacy `agent-*.jsonl` files. */
export async function firstSessionId(path: string, maxBytes = 256 * 1024): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
      try {
        const id = str(object(JSON.parse(line)).sessionId);
        if (id) return id;
      } catch {
        // Partial or damaged line; keep looking.
      }
    }
    return "";
  } finally {
    await handle.close();
  }
}

export interface PreviewMessage {
  role: "user" | "assistant";
  text: string;
  timestamp: string | null;
}

/** The first and last few conversational messages, for the details pane. */
export async function readPreview(path: string, head = 4, tail = 4, max = 600): Promise<PreviewMessage[]> {
  const first: PreviewMessage[] = [];
  const last: PreviewMessage[] = [];
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let o: Record<string, unknown>;
      try {
        o = object(JSON.parse(line));
      } catch {
        continue;
      }
      if ((o.type !== "user" && o.type !== "assistant") || o.isMeta === true || o.isSidechain === true) continue;
      const text = messageText(object(o.message).content);
      if (!text || (o.type === "user" && isSyntheticPrompt(text))) continue;
      const role: PreviewMessage["role"] = o.type === "user" ? "user" : "assistant";
      const message: PreviewMessage = { role, text: clip(text, max), timestamp: str(o.timestamp) || null };
      if (first.length < head) first.push(message);
      else {
        last.push(message);
        if (last.length > tail) last.shift();
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return [...first, ...last];
}
