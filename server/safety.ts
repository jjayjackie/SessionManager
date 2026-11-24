import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProviderId } from "../shared/schema";

/**
 * Filesystem guards. The plugin only ever moves paths it computed itself from a fixed, per-provider
 * allowlist of session artifact locations, and each of those passes through these checks first.
 */

export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafePathError";
  }
}

/** Identifiers that become path segments: no separators, no dot segments. */
export const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;

export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel);
}

/** Top-level folders of each provider directory that may hold session data. Nothing else is ever touched. */
export const MANAGED_TOP_LEVEL: Record<ProviderId, ReadonlySet<string>> = {
  claude: new Set(["projects", "todos", "file-history", "session-env", "debug", "tasks"]),
  codex: new Set(["sessions", "archived_sessions", "tui-thread-reference-capabilities", "shell_snapshots"]),
  antigravity: new Set(["conversations", "brain", "annotations", "presence"]),
};

function managedTop(provider: ProviderId, root: string, absolute: string): string {
  if (!isInside(root, absolute)) throw new UnsafePathError(`Outside the ${provider} directory: ${absolute}`);
  const segments = relative(root, absolute).split(sep);
  if (segments.length < 2 || !MANAGED_TOP_LEVEL[provider].has(segments[0])) {
    throw new UnsafePathError(`Not a managed ${provider} session location: ${absolute}`);
  }
  return join(root, segments[0]);
}

function within(base: string, path: string): boolean {
  return path === base || isInside(base, path);
}

/**
 * Asserts `absolute` lies below one of the managed top-level folders of `root` (a resolved
 * physical path) and is not itself a symbolic link. The top-level folder may be a symbolic link
 * (for example `projects` moved to another disk); no other link is followed.
 */
export async function assertContained(root: string, absolute: string, provider: ProviderId = "claude"): Promise<void> {
  const path = resolve(absolute);
  const base = await realpath(managedTop(provider, root, path));
  const parent = await realpath(dirname(path));
  if (!within(base, parent)) throw new UnsafePathError(`Parent escapes the ${provider} directory: ${absolute}`);
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new UnsafePathError(`Symbolic link refused: ${absolute}`);
}

/** Asserts a restore target's existing ancestors stay inside the managed folder before any directory is created. */
export async function assertRestorable(root: string, absolute: string, provider: ProviderId = "claude"): Promise<void> {
  const path = resolve(absolute);
  const top = managedTop(provider, root, path);
  let base: string;
  try {
    base = await realpath(top);
  } catch {
    if ((await realpath(root)) !== root) throw new UnsafePathError(`${provider} directory moved: ${root}`);
    return; // The folder is gone entirely; it is recreated as a plain directory.
  }
  let ancestor = dirname(path);
  for (;;) {
    try {
      const real = await realpath(ancestor);
      if (!within(base, real)) throw new UnsafePathError(`Parent escapes the ${provider} directory: ${absolute}`);
      return;
    } catch (error) {
      if (error instanceof UnsafePathError) throw error;
      if (ancestor === top) return;
      ancestor = dirname(ancestor);
    }
  }
}

/** Converts a stored relative path back to an absolute path under `root`, refusing traversal. */
export function resolveRelative(root: string, rel: string): string {
  if (!rel || isAbsolute(rel) || rel.includes("\0")) throw new UnsafePathError(`Invalid stored path: ${rel}`);
  const segments = rel.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new UnsafePathError(`Invalid stored path: ${rel}`);
  }
  const absolute = join(root, ...segments);
  if (!isInside(root, absolute)) throw new UnsafePathError(`Invalid stored path: ${rel}`);
  return absolute;
}

export function toRelative(root: string, absolute: string): string {
  return relative(root, absolute).split(sep).join("/");
}

/** Total size of a file or directory tree, never following symbolic links. */
export async function treeSize(path: string, depth = 0): Promise<{ bytes: number; files: number; newestMs: number }> {
  const info = await lstat(path);
  if (!info.isDirectory() || depth > 32) return { bytes: info.isSymbolicLink() ? 0 : info.size, files: 1, newestMs: info.mtimeMs };
  let bytes = 0;
  let files = 0;
  let newestMs = info.mtimeMs;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    try {
      const child = await treeSize(join(path, entry.name), depth + 1);
      bytes += child.bytes;
      files += child.files;
      newestMs = Math.max(newestMs, child.newestMs);
    } catch {
      // A file vanished while measuring; the size is informational.
    }
  }
  return { bytes, files, newestMs };
}
