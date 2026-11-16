import { randomBytes } from "node:crypto";
import { cp, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { FileKindSchema, TRASH_ID, type ReasonCode, type TrashEntry } from "../shared/schema";
import type { PlannedFile } from "./artifacts";
import type { ClaudeRoot } from "./roots";
import { PROJECT_DIR } from "./scanner";
import { assertContained, assertRestorable, resolveRelative, treeSize, UnsafePathError } from "./safety";
import { restoreToIndex } from "./sessions-index";

/**
 * Recoverable deletion. Each deleted session becomes `<trash>/<trash id>/` holding
 * `manifest.json` and `payload/<n>` for every moved file or directory. The manifest records each
 * item's path relative to its Claude directory; restore re-validates those paths, so an edited
 * manifest cannot write outside a configured Claude directory.
 */

const ManifestSchema = z.object({
  version: z.literal(1),
  trashId: z.string().regex(TRASH_ID),
  status: z.enum(["pending", "complete"]),
  key: z.string(),
  sessionId: z.string(),
  title: z.string(),
  cwd: z.string(),
  rootPath: z.string(),
  projectDir: z.string().regex(PROJECT_DIR),
  deletedAt: z.string(),
  items: z.array(z.object({ rel: z.string(), kind: FileKindSchema, bytes: z.number(), stored: z.string().regex(/^\d{1,6}$/) })),
  indexEntries: z.array(z.unknown()),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export class OperationError extends Error {
  constructor(readonly reason: ReasonCode, message?: string) {
    super(message ?? reason);
    this.name = "OperationError";
  }
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? "";
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
}

/** Rename, falling back to copy-and-remove across filesystems. Never overwrites. */
export async function movePath(source: string, target: string): Promise<void> {
  if (await exists(target)) throw new OperationError("conflict", `Target exists: ${target}`);
  try {
    await rename(source, target);
  } catch (error) {
    if (errorCode(error) !== "EXDEV") throw error;
    await cp(source, target, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
    await rm(source, { recursive: true, force: true });
  }
}

export interface TrashMeta {
  key: string;
  sessionId: string;
  title: string;
  cwd: string;
  root: ClaudeRoot;
  projectDir: string;
}

export class Trash {
  constructor(readonly dir: string, private readonly now: () => number = Date.now) {}

  private entryDir(trashId: string): string {
    if (!TRASH_ID.test(trashId)) throw new OperationError("not_found");
    return join(this.dir, trashId);
  }

  private async writeManifest(trashId: string, manifest: Manifest): Promise<void> {
    await writeFile(join(this.entryDir(trashId), "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  }

  async readManifest(trashId: string): Promise<Manifest> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(this.entryDir(trashId), "manifest.json"), "utf8"));
    } catch (error) {
      if (errorCode(error) === "ENOENT" && !(await exists(this.entryDir(trashId)))) throw new OperationError("not_found");
      throw new OperationError("manifest_invalid");
    }
    const parsed = ManifestSchema.safeParse(raw);
    if (!parsed.success || parsed.data.trashId !== trashId) throw new OperationError("manifest_invalid");
    return parsed.data;
  }

  /**
   * Moves `files` into a new trash entry. Every path is checked before anything moves; a failure
   * part-way moves the already-moved items back. `afterMove` runs once all items are in the trash
   * and returns the sessions-index entries to keep for a later restore.
   */
  async moveIn(meta: TrashMeta, files: PlannedFile[], afterMove: () => Promise<unknown[]>): Promise<string> {
    for (const file of files) await assertContained(meta.root.real, file.absolute);
    const trashId = `${this.now()}-${randomBytes(6).toString("hex")}`;
    const entryDir = this.entryDir(trashId);
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    await mkdir(join(entryDir, "payload"), { recursive: true, mode: 0o700 });
    const manifest: Manifest = {
      version: 1, trashId, status: "pending", key: meta.key, sessionId: meta.sessionId, title: meta.title, cwd: meta.cwd,
      rootPath: meta.root.real, projectDir: meta.projectDir, deletedAt: new Date(this.now()).toISOString(),
      items: files.map((file, index) => ({ rel: file.rel, kind: file.kind, bytes: file.bytes, stored: String(index) })),
      indexEntries: [],
    };
    await this.writeManifest(trashId, manifest);
    const moved: { from: string; to: string }[] = [];
    try {
      for (const [index, file] of files.entries()) {
        const to = join(entryDir, "payload", String(index));
        await movePath(file.absolute, to);
        moved.push({ from: file.absolute, to });
      }
    } catch (error) {
      for (const item of moved.reverse()) {
        try {
          await movePath(item.to, item.from);
        } catch {
          // Leave the entry in place so nothing is lost; it lists as incomplete and can be restored.
          throw error;
        }
      }
      await rm(entryDir, { recursive: true, force: true });
      throw error;
    }
    let indexEntries: unknown[] = [];
    try {
      indexEntries = await afterMove();
    } catch {
      // The transcript is already gone; Claude Code rebuilds a stale index entry on its own.
    }
    await this.writeManifest(trashId, { ...manifest, status: "complete", indexEntries });
    return trashId;
  }

  async list(): Promise<{ entries: TrashEntry[]; bytes: number }> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return { entries: [], bytes: 0 };
    }
    const entries: TrashEntry[] = [];
    for (const name of names) {
      if (!TRASH_ID.test(name)) continue;
      try {
        const manifest = await this.readManifest(name);
        entries.push({
          trashId: name, sessionId: manifest.sessionId, title: manifest.title, cwd: manifest.cwd, rootPath: manifest.rootPath,
          projectDirectory: manifest.projectDir, deletedAt: manifest.deletedAt,
          bytes: manifest.items.reduce((sum, item) => sum + item.bytes, 0), files: manifest.items.length,
          status: manifest.status === "complete" ? "complete" : "incomplete",
        });
      } catch {
        let bytes = 0;
        try {
          bytes = (await treeSize(join(this.dir, name))).bytes;
        } catch {
          // Vanished while listing.
          continue;
        }
        const deletedAt = new Date(Number(name.slice(0, 13))).toISOString();
        entries.push({ trashId: name, sessionId: "", title: "", cwd: "", rootPath: "", projectDirectory: "", deletedAt, bytes, files: 0, status: "invalid" });
      }
    }
    entries.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
    return { entries, bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0) };
  }

  /** Restores every item of an entry, or nothing when any target already exists. */
  async restore(trashId: string, roots: ClaudeRoot[]): Promise<Manifest> {
    const manifest = await this.readManifest(trashId);
    const root = roots.find((candidate) => candidate.real === manifest.rootPath);
    if (!root) throw new OperationError("root_unavailable");
    const entryDir = this.entryDir(trashId);
    const plan: { from: string; to: string }[] = [];
    for (const item of manifest.items) {
      let target: string;
      try {
        target = resolveRelative(root.real, item.rel);
        await assertRestorable(root.real, target);
      } catch {
        throw new OperationError("unsafe_path");
      }
      const from = join(entryDir, "payload", item.stored);
      if (!(await exists(from))) continue; // An incomplete entry holds only what was moved.
      if (await exists(target)) throw new OperationError("conflict");
      plan.push({ from, to: target });
    }
    const moved: { from: string; to: string }[] = [];
    try {
      for (const item of plan) {
        await assertRestorable(root.real, item.to);
        await mkdir(dirname(item.to), { recursive: true });
        await movePath(item.from, item.to);
        moved.push(item);
      }
    } catch (error) {
      for (const item of moved.reverse()) {
        try {
          await movePath(item.to, item.from);
        } catch {
          break;
        }
      }
      if (error instanceof OperationError) throw error;
      throw new OperationError(error instanceof UnsafePathError ? "unsafe_path" : "io_error", String(error));
    }
    try {
      await restoreToIndex(join(root.real, "projects", manifest.projectDir), manifest.sessionId, manifest.indexEntries);
    } catch {
      // Claude Code rebuilds the index from transcripts when needed.
    }
    await rm(entryDir, { recursive: true, force: true });
    return manifest;
  }

  async purge(trashId: string): Promise<void> {
    const entryDir = this.entryDir(trashId);
    if (!(await exists(entryDir))) throw new OperationError("not_found");
    await rm(entryDir, { recursive: true, force: true });
  }

  async ids(): Promise<string[]> {
    try {
      return (await readdir(this.dir)).filter((name) => TRASH_ID.test(name));
    } catch {
      return [];
    }
  }
}
