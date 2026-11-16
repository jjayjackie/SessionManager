import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Root discovery is adapted from upstream session-usage (server/indexer.ts and
 * server/paseo-home.ts, MIT, panrafal/paseo-plugins): the daemon's own Claude directory plus one per
 * Paseo provider whose environment sets CLAUDE_CONFIG_DIR.
 */

export interface ClaudeRoot {
  /** Stable short ID derived from the resolved path. */
  id: string;
  /** Path as configured, after `~` expansion. */
  path: string;
  /** Resolved physical path; every safety check compares against it. */
  real: string;
  isDefault: boolean;
  source: "env" | "default" | "paseo-provider";
  available: boolean;
}

export function expandHome(path: string, home = homedir()): string {
  if (path === "~") return home;
  return resolve(path.startsWith("~/") ? join(home, path.slice(2)) : path);
}

export function paseoHome(env: NodeJS.ProcessEnv = process.env): string {
  return expandHome(env.PASEO_HOME?.trim() || "~/.paseo");
}

export function rootId(realPath: string): string {
  return createHash("sha256").update(realPath).digest("hex").slice(0, 12);
}

async function physical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * CLAUDE_CONFIG_DIR values from Paseo provider profiles. Only that one variable is read: provider
 * commands and the rest of the environment may hold credentials.
 */
export async function providerConfigDirs(paseoHomePath: string): Promise<string[]> {
  let config: unknown;
  try {
    config = JSON.parse(await readFile(join(paseoHomePath, "config.json"), "utf8"));
  } catch {
    return [];
  }
  const result: string[] = [];
  for (const provider of Object.values(object(object(object(config).agents).providers))) {
    const value = object(object(provider).env).CLAUDE_CONFIG_DIR;
    if (typeof value === "string" && value.trim()) result.push(expandHome(value.trim()));
  }
  return result;
}

export interface RootOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  paseoHome?: string;
}

/** Every Claude configuration directory on this host, deduplicated by physical path. */
export async function discoverRoots(options: RootOptions = {}): Promise<ClaudeRoot[]> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const configured = env.CLAUDE_CONFIG_DIR?.trim();
  const defaultPath = join(home, ".claude");
  const candidates: { path: string; source: ClaudeRoot["source"] }[] = [];
  if (configured) candidates.push({ path: expandHome(configured, home), source: "env" });
  candidates.push({ path: defaultPath, source: "default" });
  for (const path of await providerConfigDirs(options.paseoHome ?? paseoHome(env))) {
    candidates.push({ path, source: "paseo-provider" });
  }
  const defaultReal = await physical(defaultPath);
  const seen = new Set<string>();
  const roots: ClaudeRoot[] = [];
  for (const candidate of candidates) {
    const real = await physical(candidate.path);
    if (seen.has(real)) continue;
    seen.add(real);
    const available = await isDirectory(join(real, "projects"));
    // The default directory is listed even when empty; extra profiles only when they hold sessions.
    if (!available && candidate.source === "paseo-provider") continue;
    roots.push({ id: rootId(real), path: candidate.path, real, isDefault: real === defaultReal, source: candidate.source, available });
  }
  return roots;
}
