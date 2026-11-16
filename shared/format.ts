/** Plain helpers shared by the app and the daemon. No runtime-specific imports. */

/** POSIX single-quote a shell word. */
export function shellQuote(value: string): string {
  if (value !== "" && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface ResumeTarget {
  sessionId: string;
  cwd: string;
  /** Claude configuration directory holding the transcript. */
  rootPath: string;
  isDefaultRoot: boolean;
}

/**
 * The command that reopens a session in Claude Code. Claude looks sessions up in the project
 * directory of the current working directory, so the command changes into the recorded cwd, and it
 * selects a non-default configuration directory explicitly.
 */
export function resumeCommand(target: ResumeTarget): string {
  const parts: string[] = [];
  if (target.cwd) parts.push(`cd ${shellQuote(target.cwd)} &&`);
  if (!target.isDefaultRoot) parts.push(`CLAUDE_CONFIG_DIR=${shellQuote(target.rootPath)}`);
  parts.push("claude", "--resume", shellQuote(target.sessionId));
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
  return ["claude-session-manager", hostId, ...parts];
}

/** Collapse whitespace and cut to `max` code points with an ellipsis. */
export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}
