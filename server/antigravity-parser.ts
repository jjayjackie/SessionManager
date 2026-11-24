import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { clip } from "../shared/format";
import { emptyTranscript, MAX_SEARCH_TEXT, type ParsedTranscript, type PreviewMessage } from "./parser";

/**
 * Reads Antigravity conversation metadata (`cache/conversation_metadata.json`) and streams
 * per-conversation logs (`brain/<id>/.system_generated/logs/transcript.jsonl`). Pure Node.js
 * without native SQLite dependencies so it runs safely on any Paseo daemon host.
 */

const MAX_PROMPT = 400;

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function workspaceUriToPath(uri: string): string {
  if (!uri) return "";
  if (uri.startsWith("file://")) {
    try {
      return fileURLToPath(uri);
    } catch {
      return uri.replace(/^file:\/\//, "");
    }
  }
  return uri;
}

/** Extracts the inner user prompt from Antigravity's `<USER_REQUEST>...</USER_REQUEST>` envelope. */
export function extractAntigravityUserText(raw: string): string {
  const match = /<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i.exec(raw);
  if (match) return match[1].trim();
  // Strip trailing metadata tags if the request wasn't wrapped in USER_REQUEST.
  return raw
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, "")
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, "")
    .trim();
}

export interface AntigravityMeta {
  title: string;
  preview: string;
  cwd: string;
  updatedAt: string | null;
  numSteps: number;
  projectId: string;
  agentName: string;
}

export async function readAntigravityMetadata(rootReal: string): Promise<Map<string, AntigravityMeta>> {
  const result = new Map<string, AntigravityMeta>();
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(rootReal, "cache", "conversation_metadata.json"), "utf8"));
  } catch {
    return result;
  }
  const conversations = object(object(raw).conversations);
  for (const [id, entry] of Object.entries(conversations)) {
    const summary = object(object(entry).summary);
    const uris = Array.isArray(summary.WorkspaceURIs) ? summary.WorkspaceURIs.filter((u): u is string => typeof u === "string") : [];
    const cwd = uris.length ? workspaceUriToPath(uris[0]) : "";
    const rawUpdated = str(summary.UpdatedAt);
    const updatedAt = rawUpdated && !rawUpdated.startsWith("0001-01-01") && !Number.isNaN(Date.parse(rawUpdated)) ? rawUpdated : null;
    result.set(id, {
      title: str(summary.Title),
      preview: str(summary.Preview),
      cwd,
      updatedAt,
      numSteps: typeof summary.NumSteps === "number" ? summary.NumSteps : 0,
      projectId: str(summary.ProjectID),
      agentName: str(summary.AgentName),
    });
  }
  return result;
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

export interface ParsedAntigravityTranscript {
  parsed: ParsedTranscript;
  subagentCount: number;
}

export class AntigravityTranscriptAccumulator {
  readonly result = emptyTranscript();
  private readonly models = new Set<string>();
  private readonly search = new SearchBuffer();
  subagentCount = 0;

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
    this.bumpTime(str(o.created_at) || str(o.timestamp));

    if (type === "USER_INPUT") {
      const text = extractAntigravityUserText(str(o.content));
      if (!text) return;
      r.userMessages += 1;
      if (!r.firstPrompt) r.firstPrompt = clip(text, MAX_PROMPT);
      r.lastPrompt = clip(text, MAX_PROMPT);
      this.search.add(text);
      return;
    }

    if (type === "PLANNER_RESPONSE") {
      const model = str(o.model);
      if (model) this.models.add(model);
      const toolCalls = Array.isArray(o.tool_calls) ? o.tool_calls : [];
      for (const call of toolCalls) {
        const name = str(object(call).name);
        if (name === "invoke_subagent") this.subagentCount += 1;
      }
      const content = str(o.content).trim();
      if (content) {
        r.assistantMessages += 1;
        this.search.add(content);
      }
    }
  }

  finish(sessionId: string, meta?: AntigravityMeta): ParsedAntigravityTranscript {
    const r = this.result;
    r.sessionIds = [sessionId];
    r.models = [...this.models].sort();
    if (meta) {
      if (meta.title) r.aiTitle = meta.title;
      if (meta.cwd && !r.cwd) r.cwd = meta.cwd;
      if (meta.preview && !r.summary) r.summary = meta.preview;
      if (meta.updatedAt && (!r.endedAt || meta.updatedAt > r.endedAt)) r.endedAt = meta.updatedAt;
    }
    this.search.add([r.aiTitle, r.summary, r.firstPrompt, r.lastPrompt].filter(Boolean).join("\n"));
    r.searchText = this.search.toString();
    return { parsed: r, subagentCount: this.subagentCount };
  }
}

export async function parseAntigravityTranscript(path: string, sessionId: string, meta?: AntigravityMeta): Promise<ParsedAntigravityTranscript> {
  const accumulator = new AntigravityTranscriptAccumulator();
  const stream = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) accumulator.line(line);
  } finally {
    lines.close();
    stream.destroy();
  }
  return accumulator.finish(sessionId, meta);
}

export function metadataOnlyTranscript(sessionId: string, meta?: AntigravityMeta): ParsedAntigravityTranscript {
  const accumulator = new AntigravityTranscriptAccumulator();
  return accumulator.finish(sessionId, meta);
}

export async function readAntigravityPreview(path: string, head = 4, tail = 4, max = 600): Promise<PreviewMessage[]> {
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
      const type = str(o.type);
      const ts = str(o.created_at) || str(o.timestamp) || null;
      let role: PreviewMessage["role"] | null = null;
      let text = "";
      if (type === "USER_INPUT") {
        role = "user";
        text = extractAntigravityUserText(str(o.content));
      } else if (type === "PLANNER_RESPONSE") {
        role = "assistant";
        text = str(o.content).trim();
      }
      if (!role || !text) continue;
      const message: PreviewMessage = { role, text: clip(text, max), timestamp: ts };
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
