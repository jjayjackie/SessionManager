import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ProviderId } from "../shared/schema";

/**
 * Root discovery for Claude Code, Codex, and Antigravity. Adapted from upstream session-usage
 * (server/indexer.ts and server/paseo-home.ts, MIT, panrafal/paseo-plugins): discovers the
 * daemon's own agent directories plus any custom paths configured in Paseo provider profiles.
 */

export interface AgentRoot {
  /** Stable short ID derived from provider + resolved physical path. */
  id: string;
  provider: ProviderId;
  /** Path as configured, after `~` expansion. */
  path: string;
  /** Resolved physical path; every safety check compares against it. */
  real: string;
  isDefault: boolean;
  source: "env" | "default" | "paseo-provider";
  available: boolean;
}

export type ClaudeRoot = AgentRoot;

export function expandHome(path: string, home = homedir()): string {
  if (path === "~") return home;
  return resolve(path.startsWith("~/") ? join(home, path.slice(2)) : path);
}

export function paseoHome(env: NodeJS.ProcessEnv = process.env): string {
  return expandHome(env.PASEO_HOME?.trim() || "~/.paseo");
}

export function rootId(realPath: string, provider: ProviderId = "claude"): string {
  const input = provider === "claude" ? realPath : `${provider}:${realPath}`;
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
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

interface ProviderEnvDirs {
  claude: string[];
  codex: string[];
  antigravity: string[];
}

/**
 * Reads only the directory environment variables (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
 * `ANTIGRAVITY_DATA_DIR`, `ANTIGRAVITY_CLI_DIR`) from Paseo provider profiles. Other variables
 * and provider commands may hold credentials and are never read.
 */
export async function providerConfigDirs(paseoHomePath: string, home = homedir()): Promise<ProviderEnvDirs> {
  const result: ProviderEnvDirs = { claude: [], codex: [], antigravity: [] };
  let config: unknown;
  try {
    config = JSON.parse(await readFile(join(paseoHomePath, "config.json"), "utf8"));
  } catch {
    return result;
  }
  for (const provider of Object.values(object(object(object(config).agents).providers))) {
    const env = object(object(provider).env);
    const claudeDir = env.CLAUDE_CONFIG_DIR;
    if (typeof claudeDir === "string" && claudeDir.trim()) result.claude.push(expandHome(claudeDir.trim(), home));
    const codexDir = env.CODEX_HOME;
    if (typeof codexDir === "string" && codexDir.trim()) result.codex.push(expandHome(codexDir.trim(), home));
    for (const key of ["ANTIGRAVITY_DATA_DIR", "ANTIGRAVITY_CLI_DIR"] as const) {
      const agyDir = env[key];
      if (typeof agyDir === "string" && agyDir.trim()) result.antigravity.push(expandHome(agyDir.trim(), home));
    }
  }
  return result;
}

async function rootAvailable(provider: ProviderId, real: string): Promise<boolean> {
  if (provider === "claude") return isDirectory(join(real, "projects"));
  if (provider === "codex") {
    return (await isDirectory(join(real, "sessions"))) || (await isDirectory(join(real, "archived_sessions")));
  }
  return (await isDirectory(join(real, "conversations"))) || (await isDirectory(join(real, "brain")));
}

export interface RootOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  paseoHome?: string;
}

/** Every Claude Code, Codex, and Antigravity data directory on this host, deduplicated per provider. */
export async function discoverRoots(options: RootOptions = {}): Promise<AgentRoot[]> {
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const providerDirs = await providerConfigDirs(options.paseoHome ?? paseoHome(env), home);

  interface Candidate {
    provider: ProviderId;
    path: string;
    source: AgentRoot["source"];
    keepIfUnavailable?: boolean;
  }

  const claudeDefault = join(home, ".claude");
  const codexDefault = join(home, ".codex");
  const agyCliDefault = join(home, ".gemini", "antigravity-cli");
  const agyIdeDefault = join(home, ".gemini", "antigravity");

  const candidates: Candidate[] = [];

  // Claude Code
  const claudeEnv = env.CLAUDE_CONFIG_DIR?.trim();
  if (claudeEnv) candidates.push({ provider: "claude", path: expandHome(claudeEnv, home), source: "env", keepIfUnavailable: true });
  candidates.push({ provider: "claude", path: claudeDefault, source: "default", keepIfUnavailable: true });
  for (const path of providerDirs.claude) candidates.push({ provider: "claude", path, source: "paseo-provider" });

  // Codex
  const codexEnv = env.CODEX_HOME?.trim();
  if (codexEnv) candidates.push({ provider: "codex", path: expandHome(codexEnv, home), source: "env", keepIfUnavailable: true });
  candidates.push({ provider: "codex", path: codexDefault, source: "default" });
  for (const path of providerDirs.codex) candidates.push({ provider: "codex", path, source: "paseo-provider" });

  // Antigravity
  for (const key of ["ANTIGRAVITY_DATA_DIR", "ANTIGRAVITY_CLI_DIR"] as const) {
    const agyEnv = env[key]?.trim();
    if (agyEnv) candidates.push({ provider: "antigravity", path: expandHome(agyEnv, home), source: "env", keepIfUnavailable: true });
  }
  candidates.push({ provider: "antigravity", path: agyCliDefault, source: "default" });
  candidates.push({ provider: "antigravity", path: agyIdeDefault, source: "default" });
  for (const path of providerDirs.antigravity) candidates.push({ provider: "antigravity", path, source: "paseo-provider" });

  const defaultReals: Record<ProviderId, Set<string>> = {
    claude: new Set([await physical(claudeDefault)]),
    codex: new Set([await physical(codexDefault)]),
    antigravity: new Set([await physical(agyCliDefault), await physical(agyIdeDefault)]),
  };

  const seen = new Set<string>();
  const roots: AgentRoot[] = [];
  for (const candidate of candidates) {
    const real = await physical(candidate.path);
    const dedupeKey = `${candidate.provider}:${real}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const available = await rootAvailable(candidate.provider, real);
    if (!available && !candidate.keepIfUnavailable) continue;
    roots.push({
      id: rootId(real, candidate.provider),
      provider: candidate.provider,
      path: candidate.path,
      real,
      isDefault: defaultReals[candidate.provider].has(real),
      source: candidate.source,
      available,
    });
  }
  return roots;
}
