import type { ProviderId } from "./schema";

/** Plain helpers shared by the app and the daemon. No runtime-specific imports. */

/** POSIX single-quote a shell word. */
export function shellQuote(value: string): string {
  if (value !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ResumeTarget {
  provider: ProviderId;
  sessionId: string;
  cwd: string;
  /** Provider configuration/data directory holding the session. */
  rootPath: string;
  isDefaultRoot: boolean;
}

/**
 * Builds the CLI command that reopens a session in its native coding agent.
 * - Claude Code: `cd <cwd> && [CLAUDE_CONFIG_DIR=<root>] claude --resume <id>`
 * - Codex:       `cd <cwd> && [CODEX_HOME=<root>] codex resume <id>`
 * - Antigravity: `cd <cwd> && agy --conversation <id>`
 */
export function resumeCommand(target: ResumeTarget): string {
  const parts: string[] = [];
  if (target.cwd) parts.push(`cd ${shellQuote(target.cwd)} &&`);
  if (target.provider === "claude") {
    if (!target.isDefaultRoot) parts.push(`CLAUDE_CONFIG_DIR=${shellQuote(target.rootPath)}`);
    parts.push("claude", "--resume", shellQuote(target.sessionId));
  } else if (target.provider === "codex") {
    if (!target.isDefaultRoot) parts.push(`CODEX_HOME=${shellQuote(target.rootPath)}`);
    parts.push("codex", "resume", shellQuote(target.sessionId));
  } else {
    parts.push("agy", "--conversation", shellQuote(target.sessionId));
  }
  return parts.join(" ");
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/**
 * Query keys always start with the host ID, so cached data from one host is never shown for
 * another, even if the app shares a cache between installations.
 */
export function hostKey(hostId: string, ...parts: readonly unknown[]): readonly unknown[] {
  return ["session-manager", hostId, ...parts];
}

/** Collapse whitespace and cut to `max` code points with an ellipsis. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}
