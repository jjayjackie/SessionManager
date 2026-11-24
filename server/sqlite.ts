import { lstat } from "node:fs/promises";

/**
 * Optional read-only SQLite query helper backed by Node's built-in `node:sqlite` (Node 22.5+).
 * Never writes to agent databases and gracefully returns `null` when `node:sqlite` is unavailable
 * or the database is absent/locked.
 */

interface SqliteStatement {
  all(): Record<string, unknown>[];
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type DatabaseSyncCtor = new (path: string, options?: { readOnly?: boolean; timeout?: number }) => SqliteDatabase;

let cachedCtor: DatabaseSyncCtor | null | undefined;

async function getDatabaseSync(): Promise<DatabaseSyncCtor | null> {
  if (cachedCtor !== undefined) return cachedCtor;
  try {
    const specifier = "node:sqlite";
    const mod = (await import(specifier)) as { DatabaseSync?: DatabaseSyncCtor };
    cachedCtor = mod.DatabaseSync ?? null;
  } catch {
    cachedCtor = null;
  }
  return cachedCtor;
}

export async function querySqliteReadOnly(dbPath: string, sql: string): Promise<Record<string, unknown>[] | null> {
  try {
    const info = await lstat(dbPath);
    if (!info.isFile()) return null;
  } catch {
    return null;
  }
  const DatabaseSync = await getDatabaseSync();
  if (!DatabaseSync) return null;

  let db: SqliteDatabase | null = null;
  try {
    try {
      db = new DatabaseSync(dbPath, { readOnly: true, timeout: 1000 });
    } catch {
      db = new DatabaseSync(dbPath, { readOnly: true });
    }
    return db.prepare(sql).all();
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close errors
    }
  }
}
