import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { hostKey, resumeCommand } from "../shared/format";
import { DeleteInputSchema, PurgeInputSchema, RestoreInputSchema } from "../shared/schema";
import { discoverRoots, rootId } from "./roots";
import { sessionKey } from "./scanner";
import {
  age,
  assistant,
  digest,
  encodeProject,
  makeHost,
  manager,
  query,
  tree,
  user,
  writeFileDeep,
  writeFullAntigravitySession,
  writeFullCodexSession,
  writeFullSession,
  writeSentinels,
  writeTranscript,
  type FakeHost,
} from "./testkit";

const PROJECT = encodeProject("/work/app");
const OTHER = encodeProject("/work/other");

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

describe("session manager", () => {
  let host: FakeHost;
  beforeEach(async () => {
    host = await makeHost();
  });
  afterEach(async () => {
    await host.cleanup();
  });

  const key = (sessionId: string, project = PROJECT) => sessionKey(host.root.id, project, sessionId, "claude");
  const codexKey = (sessionId: string, relDir = "sessions/2026/11/24") => sessionKey(host.codexRoot.id, relDir, sessionId, "codex");
  const agyKey = (sessionId: string) => sessionKey(host.antigravityRoot.id, "conversations", sessionId, "antigravity");

  it("lists sessions across Claude, Codex, and Antigravity and unifies shared project folders", async () => {
    const claudeId = await writeFullSession(host, PROJECT);
    const otherClaudeId = randomUUID();
    await writeTranscript(host, OTHER, otherClaudeId, [user(otherClaudeId, "Write docs", { cwd: "/work/other" }), assistant(otherClaudeId, "Sure")]);
    await writeFileDeep(join(host.claude, "projects", OTHER, "agent-legacy1.jsonl"), `${JSON.stringify(user(otherClaudeId, "legacy subtask", { isSidechain: true }))}\n`);
    await writeFileDeep(join(host.claude, "projects", PROJECT, "memory", "MEMORY.md"), "memory");
    await writeFileDeep(join(host.claude, "projects", PROJECT, "sessions-index.json"), JSON.stringify({ version: 1, entries: [] }));
    await writeFileDeep(join(host.claude, "projects", PROJECT, "notes.txt"), "not a session");

    const codex = await writeFullCodexSession(host, { cwd: "/work/app", title: "Cache optimization" });
    const agyId = await writeFullAntigravitySession(host, { cwd: "/work/app", title: "Telemetry refactor" });

    const m = manager(host);
    const result = await m.list(query());
    assert.equal(result.total, 4);
    assert.deepEqual(result.stats.byProvider, { claude: 2, codex: 1, antigravity: 1 });
    assert.equal(result.stats.projects, 2, "sessions sharing /work/app across providers unify into one project");

    const appProject = result.projects.find((p) => p.path === "/work/app");
    assert.ok(appProject);
    assert.equal(appProject.sessions, 3);
    assert.deepEqual(appProject.providers, ["claude", "codex", "antigravity"]);

    const first = result.items.find((item) => item.sessionId === claudeId);
    const second = result.items.find((item) => item.sessionId === otherClaudeId);
    const codexItem = result.items.find((item) => item.sessionId === codex.sessionId);
    const agyItem = result.items.find((item) => item.sessionId === agyId);
    assert.ok(first && second && codexItem && agyItem);
    assert.equal(first.title, "Fix the login bug");
    assert.equal(first.subagentCount, 1);
    assert.equal(second.subagentCount, 1, "legacy agent-*.jsonl is attached by its sessionId");
    assert.equal(codexItem.provider, "codex");
    assert.equal(codexItem.title, "Cache optimization");
    assert.equal(agyItem.provider, "antigravity");
    assert.equal(agyItem.title, "Telemetry refactor");
    assert.equal(agyItem.subagentCount, 1);

    // Provider filtering preserves global byProvider counts while filtering items and projects.
    const onlyCodex = await m.list(query({ provider: "codex" }));
    assert.equal(onlyCodex.total, 1);
    assert.equal(onlyCodex.items[0].sessionId, codex.sessionId);
    assert.deepEqual(onlyCodex.stats.byProvider, { claude: 2, codex: 1, antigravity: 1 });

    const onlyAgy = await m.list(query({ provider: "antigravity" }));
    assert.equal(onlyAgy.total, 1);
    assert.equal(onlyAgy.items[0].sessionId, agyId);
  });

  it("searches prompts and replies with AND terms, filters, sorts, and paginates", async () => {
    for (let index = 0; index < 7; index += 1) {
      const id = randomUUID();
      await writeTranscript(host, PROJECT, id, [user(id, `Task number ${index}`), assistant(id, index === 3 ? "The flux capacitor is fixed" : "Done")]);
    }
    const m = manager(host);
    const hit = await m.list(query({ search: "FLUX capacitor" }));
    assert.equal(hit.total, 1);
    assert.match(hit.items[0].snippet ?? "", /flux capacitor/);
    assert.equal((await m.list(query({ search: "flux missing-term" }))).total, 0);
    const paged = await m.list(query({ pageSize: 5, page: 1, sort: "title", direction: "asc" }));
    assert.equal(paged.total, 7);
    assert.equal(paged.items.length, 2);
    assert.equal(paged.items[1].title, "Task number 6");
    assert.equal((await m.list(query({ projectKey: "cwd:/work/other" }))).total, 0);
    assert.equal((await m.list(query({ origin: "paseo" }))).total, 0);
  });

  it("marks damaged and empty transcripts and still deletes them", async () => {
    const damaged = randomUUID();
    const empty = randomUUID();
    await writeTranscript(host, PROJECT, damaged, [user(damaged, "hi"), "{broken"]);
    await writeTranscript(host, PROJECT, empty, [{ type: "summary", summary: "orphan summary", leafUuid: "x" }]);
    const m = manager(host);
    assert.equal((await m.list(query({ health: "damaged" }))).items[0].sessionId, damaged);
    assert.equal((await m.list(query({ health: "empty" }))).items[0].sessionId, empty);
    const preview = await m.previewDelete([key(damaged), key(empty)]);
    assert.equal(preview.deletable, 2);
    const result = await m.deleteSessions(preview.items.map((item) => ({ key: item.key, fingerprint: item.fingerprint })));
    assert.ok(result.results.every((item) => item.ok));
  });

  it("moves exactly the Claude session's artifacts to the trash and never touches configuration or source", async () => {
    const id = await writeFullSession(host, PROJECT);
    const keep = await writeFullSession(host, PROJECT, randomUUID(), "Keep me");
    const sentinels = await writeSentinels(host, PROJECT);
    await writeFileDeep(
      join(host.claude, "projects", PROJECT, "sessions-index.json"),
      JSON.stringify({ version: 1, originalPath: "/work/app", entries: [{ sessionId: id, summary: "x" }, { sessionId: keep, summary: "y" }] }),
    );
    const before = await digest(sentinels);
    const m = manager(host);
    const preview = await m.previewDelete([key(id)]);
    assert.deepEqual(preview.items[0].files.map((file) => file.kind).sort(), ["debug", "file-history", "session-dir", "session-env", "todo", "transcript"]);
    const result = await m.deleteSessions([{ key: key(id), fingerprint: preview.items[0].fingerprint }]);
    assert.equal(result.results[0].ok, true);
    assert.equal(await exists(join(host.claude, "projects", PROJECT, `${id}.jsonl`)), false);
    assert.equal(await exists(join(host.claude, "projects", PROJECT, id)), false);
    assert.equal(await exists(join(host.claude, "file-history", id)), false);
    assert.equal(await exists(join(host.claude, "projects", PROJECT, `${keep}.jsonl`)), true, "other sessions stay");
    assert.equal(await exists(join(host.claude, "file-history", keep)), true);
    const index = JSON.parse(await readFile(join(host.claude, "projects", PROJECT, "sessions-index.json"), "utf8"));
    assert.deepEqual(index.entries.map((entry: { sessionId: string }) => entry.sessionId), [keep], "the /resume index no longer lists it");
    assert.equal(index.originalPath, "/work/app", "unknown index fields are preserved");
    assert.equal(await digest(sentinels), before, "configuration, memory, credentials, skills and source are unchanged");
    const listed = await m.list(query());
    assert.deepEqual(listed.items.map((item) => item.sessionId), [keep]);
    assert.equal(listed.stats.trashEntries, 1);
    await m.purge([], true);
    assert.equal(await digest(sentinels), before);
  });

  it("deletes and restores Codex sessions byte for byte, syncing session_index.jsonl and sparing sentinels", async () => {
    const codex = await writeFullCodexSession(host, { title: "Codex cleanup" });
    const sentinels = await writeSentinels(host, PROJECT);
    const beforeSentinels = await digest(sentinels);
    const beforeTree = await tree(host.codex);

    const m = manager(host);
    const targetKey = codexKey(codex.sessionId, codex.relDir);
    const detail = await m.detail(targetKey);
    assert.equal(detail.session.provider, "codex");
    assert.equal(detail.preview.length, 2);

    const preview = await m.previewDelete([targetKey]);
    assert.equal(preview.deletable, 1);
    assert.deepEqual(preview.items[0].files.map((f) => f.kind).sort(), ["codex-capabilities", "rollout", "shell-snapshot"]);

    const deleted = await m.deleteSessions([{ key: targetKey, fingerprint: preview.items[0].fingerprint }]);
    assert.equal(deleted.results[0].ok, true);
    assert.equal(await exists(codex.rolloutPath), false);
    assert.equal(await exists(join(host.codex, "tui-thread-reference-capabilities", codex.sessionId)), false);
    assert.equal(await readFile(join(host.codex, "session_index.jsonl"), "utf8"), "");
    assert.equal(await digest(sentinels), beforeSentinels, "Codex auth, config, sqlite and source are untouched");

    const trash = await m.listTrash();
    assert.equal(trash.entries.length, 1);
    assert.equal(trash.entries[0].provider, "codex");

    const restored = await m.restore([trash.entries[0].trashId]);
    assert.equal(restored.results[0].ok, true);
    const afterTree = await tree(host.codex);
    assert.deepEqual(afterTree, beforeTree);
    assert.equal((await m.list(query({ provider: "codex" }))).total, 1);
  });

  it("deletes and restores Antigravity sessions byte for byte, protects live WAL DBs, and spares sentinels", async () => {
    const agyId = await writeFullAntigravitySession(host, { title: "Antigravity task" });
    const sentinels = await writeSentinels(host, PROJECT);
    const beforeSentinels = await digest(sentinels);
    const beforeTree = await tree(host.antigravity);

    const m = manager(host);
    const targetKey = agyKey(agyId);

    // Presence of .db-wal marks the Antigravity session as live/running and blocks deletion.
    const walPath = join(host.antigravity, "conversations", `${agyId}.db-wal`);
    await writeFile(walPath, "active-wal");
    const liveList = await m.list(query({ provider: "antigravity", refresh: true }));
    assert.equal(liveList.items[0].state, "running");
    const blockedPreview = await m.previewDelete([targetKey]);
    assert.equal(blockedPreview.items[0].blocked, "running");

    // Once the WAL closes, deletion succeeds cleanly.
    const { rm } = await import("node:fs/promises");
    await rm(walPath);

    const preview = await m.previewDelete([targetKey]);
    assert.equal(preview.deletable, 1);
    assert.deepEqual(preview.items[0].files.map((f) => f.kind).sort(), ["annotation", "brain-dir", "conversation-db", "presence"]);

    const deleted = await m.deleteSessions([{ key: targetKey, fingerprint: preview.items[0].fingerprint }]);
    assert.equal(deleted.results[0].ok, true);
    assert.equal(await exists(join(host.antigravity, "conversations", `${agyId}.db`)), false);
    assert.equal(await exists(join(host.antigravity, "brain", agyId)), false);
    const metaAfter = JSON.parse(await readFile(join(host.antigravity, "cache", "conversation_metadata.json"), "utf8"));
    assert.equal(metaAfter.conversations[agyId], undefined);
    assert.equal(await digest(sentinels), beforeSentinels, "Antigravity settings, summaries DB, auth cache and source are untouched");

    const trash = await m.listTrash();
    assert.equal(trash.entries[0].provider, "antigravity");

    const restored = await m.restore([trash.entries[0].trashId]);
    assert.equal(restored.results[0].ok, true);
    const afterTree = await tree(host.antigravity);
    assert.deepEqual(afterTree, beforeTree);
    assert.equal((await m.list(query({ provider: "antigravity" }))).total, 1);
  });

  it("restores a deleted Claude session byte for byte, including its index entry", async () => {
    const id = await writeFullSession(host, PROJECT);
    await writeFileDeep(join(host.claude, "projects", PROJECT, "sessions-index.json"), JSON.stringify({ version: 1, entries: [{ sessionId: id, firstPrompt: "p" }] }));
    const snapshot = await tree(host.claude);
    const m = manager(host);
    const preview = await m.previewDelete([key(id)]);
    await m.deleteSessions([{ key: key(id), fingerprint: preview.items[0].fingerprint }]);
    const trash = await m.listTrash();
    assert.equal(trash.entries.length, 1);
    assert.equal(trash.entries[0].status, "complete");
    const restored = await m.restore([trash.entries[0].trashId]);
    assert.equal(restored.results[0].ok, true);
    const after = await tree(host.claude);
    const index = JSON.parse(await readFile(join(host.claude, "projects", PROJECT, "sessions-index.json"), "utf8"));
    assert.deepEqual(index.entries, [{ sessionId: id, firstPrompt: "p" }]);
    after.delete(join("projects", PROJECT, "sessions-index.json"));
    snapshot.delete(join("projects", PROJECT, "sessions-index.json"));
    assert.deepEqual(after, snapshot);
    assert.equal((await m.listTrash()).entries.length, 0);
    assert.equal((await m.list(query())).total, 1);
  });

  it("refuses to restore over an existing file and keeps the trash entry intact", async () => {
    const id = await writeFullSession(host, PROJECT);
    const m = manager(host);
    const preview = await m.previewDelete([key(id)]);
    await m.deleteSessions([{ key: key(id), fingerprint: preview.items[0].fingerprint }]);
    await writeTranscript(host, PROJECT, id, [user(id, "a new session reusing the id")]);
    const { trashId } = (await m.listTrash()).entries[0];
    const result = await m.restore([trashId]);
    assert.equal(result.results[0].reason, "conflict");
    assert.equal(await exists(join(host.claude, "file-history", id)), false, "nothing was partially restored");
    assert.equal((await m.listTrash()).entries.length, 1);
  });

  it("protects sessions owned by a live Claude Code process", async () => {
    const id = await writeFullSession(host, PROJECT);
    await writeFileDeep(join(host.claude, "sessions", "4242.json"), JSON.stringify({ pid: 4242, sessionId: id, status: "busy" }));
    const m = manager(host, { alive: (pid) => pid === 4242 });
    const listed = await m.list(query({ state: "active" }));
    assert.equal(listed.items[0].state, "running");
    const preview = await m.previewDelete([key(id)]);
    assert.equal(preview.items[0].blocked, "running");
    const result = await m.deleteSessions([{ key: key(id), fingerprint: preview.items[0].fingerprint }]);
    assert.equal(result.results[0].reason, "running");
    assert.equal(await exists(join(host.claude, "projects", PROJECT, `${id}.jsonl`)), true);
    // A dead process no longer protects it.
    const stale = manager(host, { alive: () => false });
    assert.equal((await stale.previewDelete([key(id)])).items[0].blocked, null);
  });

  it("protects recently written sessions and sessions of running Paseo agents", async () => {
    const recent = await writeFullSession(host, PROJECT);
    const paseo = await writeFullSession(host, PROJECT);
    await writeFileDeep(
      join(host.paseo, "agents", "ws1", "agent-1.json"),
      JSON.stringify({ id: "agent-1", provider: "claude", title: "Paseo agent", lastStatus: "running", createdAt: "2026-01-01", persistence: { sessionId: paseo, metadata: { token: "secret" } } }),
    );
    const m = manager(host, { recentMs: 60_000 });
    const preview = await m.previewDelete([key(recent), key(paseo)]);
    assert.equal(preview.items[0].blocked, "recent");
    assert.equal(preview.items[1].blocked, "paseo_running");
    const listed = await m.list(query({ origin: "paseo" }));
    assert.equal(listed.items[0].paseo?.title, "Paseo agent");
    assert.ok(!JSON.stringify(listed).includes("secret"), "agent persistence metadata is never exposed");
  });

  it("refuses a delete when the session changed after the preview", async () => {
    const id = await writeFullSession(host, PROJECT);
    const m = manager(host);
    const preview = await m.previewDelete([key(id)]);
    await appendFile(join(host.claude, "projects", PROJECT, `${id}.jsonl`), `${JSON.stringify(user(id, "one more"))}\n`);
    const result = await m.deleteSessions([{ key: key(id), fingerprint: preview.items[0].fingerprint }]);
    assert.equal(result.results[0].reason, "changed");
    assert.equal(await exists(join(host.claude, "projects", PROJECT, `${id}.jsonl`)), true);
  });

  it("serializes concurrent deletes of the same session from two clients", async () => {
    const id = await writeFullSession(host, PROJECT);
    const m = manager(host);
    const preview = await m.previewDelete([key(id)]);
    const item = { key: key(id), fingerprint: preview.items[0].fingerprint };
    const [first, second] = await Promise.all([m.deleteSessions([item]), m.deleteSessions([item])]);
    const outcomes = [first.results[0], second.results[0]];
    assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1);
    assert.equal(outcomes.find((outcome) => !outcome.ok)?.reason, "not_found");
    assert.equal((await m.listTrash()).entries.length, 1);
    assert.equal((await m.previewDelete(["nope/nope/nope"])).items[0].blocked, "not_found");
  });

  it("keeps shared per-session files while a duplicate transcript with the same ID remains", async () => {
    const id = await writeFullSession(host, PROJECT);
    await writeTranscript(host, OTHER, id, [user(id, "same id, other project", { cwd: "/work/other" })]);
    const m = manager(host);
    const listed = await m.list(query());
    assert.ok(listed.items.every((item) => item.duplicateId));
    const detail = await m.detail(key(id));
    assert.ok(detail.keptShared.some((file) => file.kind === "file-history"));
    assert.deepEqual(detail.duplicates, [key(id, OTHER)]);
    const firstPreview = await m.previewDelete([key(id)]);
    await m.deleteSessions([{ key: key(id), fingerprint: firstPreview.items[0].fingerprint }]);
    assert.equal(await exists(join(host.claude, "file-history", id)), true, "still used by the duplicate");
    const secondPreview = await m.previewDelete([key(id, OTHER)]);
    assert.ok(secondPreview.items[0].files.some((file) => file.kind === "file-history"));
    await m.deleteSessions([{ key: key(id, OTHER), fingerprint: secondPreview.items[0].fingerprint }]);
    assert.equal(await exists(join(host.claude, "file-history", id)), false);
  });

  it("detects resumed or forked copies through shared message UUIDs", async () => {
    const a = randomUUID();
    const b = randomUUID();
    const shared = [user(a, "original question"), assistant(a, "original answer")];
    await writeTranscript(host, PROJECT, a, shared);
    await writeTranscript(host, PROJECT, b, [...shared, user(b, "follow-up in the fork")]);
    const detail = await manager(host).detail(key(a));
    assert.deepEqual(detail.related.map((item) => [item.key, item.shared]), [[key(b), 2]]);
  });

  it("never follows symbolic links out of the agent directories", async () => {
    const id = await writeFullSession(host, PROJECT);
    const outside = join(host.base, "outside");
    await writeFileDeep(join(outside, "secret.json"), "outside data");
    await writeFileDeep(join(outside, "linked.jsonl"), `${JSON.stringify(user("x", "linked"))}\n`);
    await symlink(join(outside, "secret.json"), join(host.claude, "todos", `${id}.json`));
    await symlink(join(outside, "linked.jsonl"), join(host.claude, "projects", PROJECT, `${randomUUID()}.jsonl`));
    const m = manager(host);
    assert.equal((await m.list(query())).total, 1, "symlinked transcripts are not listed");
    const preview = await m.previewDelete([key(id)]);
    assert.ok(!preview.items[0].files.some((file) => file.path === `todos/${id}.json`), "symlinked artifacts are skipped");
    await m.deleteSessions([{ key: key(id), fingerprint: preview.items[0].fingerprint }]);
    assert.equal(await readFile(join(outside, "secret.json"), "utf8"), "outside data");
    assert.equal(await exists(join(outside, "linked.jsonl")), true);
  });

  it("rejects tampered trash manifests and unknown directories on restore", async () => {
    const id = await writeFullSession(host, PROJECT);
    const m = manager(host);
    const preview = await m.previewDelete([key(id)]);
    await m.deleteSessions([{ key: key(id), fingerprint: preview.items[0].fingerprint }]);
    const { trashId } = (await m.listTrash()).entries[0];
    const manifestPath = join(host.trash, trashId, "manifest.json");
    const original = await readFile(manifestPath, "utf8");
    for (const rel of ["../../escaped.txt", "settings.json", "/etc/passwd", "projects/../../x"]) {
      const manifest = JSON.parse(original);
      manifest.items[0].rel = rel;
      await writeFile(manifestPath, JSON.stringify(manifest));
      const result = await m.restore([trashId]);
      assert.equal(result.results[0].reason, "unsafe_path", rel);
    }
    assert.equal(await exists(join(host.base, "escaped.txt")), false);
    assert.equal(await readFile(join(host.claude, "settings.json")).catch(() => null), null);
    await writeFile(manifestPath, original);
    const elsewhere = await makeHost("elsewhere");
    try {
      const foreign = manager(host, { roots: async () => elsewhere.roots });
      assert.equal((await foreign.restore([trashId])).results[0].reason, "root_unavailable");
      await writeFile(manifestPath, "{ not json");
      assert.equal((await m.restore([trashId])).results[0].reason, "manifest_invalid");
      assert.equal((await m.listTrash()).entries[0].status, "invalid");
      assert.equal((await m.purge([trashId], false)).results[0].ok, true);
    } finally {
      await elsewhere.cleanup();
    }
  });

  it("validates RPC inputs: confirmation, fingerprints, and trash IDs", async () => {
    assert.equal(DeleteInputSchema.safeParse({ items: [{ key: "a", fingerprint: "f".repeat(64) }] }).success, false, "confirm is required");
    assert.equal(DeleteInputSchema.safeParse({ items: [{ key: "a", fingerprint: "nothex" }], confirm: true }).success, false);
    assert.equal(RestoreInputSchema.safeParse({ trashIds: ["../../etc"] }).success, false);
    assert.equal(PurgeInputSchema.safeParse({ all: true }).success, false, "purge needs explicit confirmation");
    const m = manager(host);
    assert.equal((await m.purge(["0000000000000-000000000000"], false)).results[0].reason, "not_found");
    assert.equal((await m.purge(["../../../etc"], false)).results[0].reason, "not_found", "path-like IDs never reach the filesystem");
  });

  it("isolates hosts: separate directories, catalogs, and trash", async () => {
    const remote = await makeHost("remote");
    try {
      const localId = await writeFullSession(host, PROJECT);
      const remoteId = await writeFullSession(remote, PROJECT);
      const local = manager(host);
      const other = manager(remote);
      const preview = await local.previewDelete([key(localId)]);
      await local.deleteSessions([{ key: key(localId), fingerprint: preview.items[0].fingerprint }]);
      assert.equal((await other.list(query())).total, 1);
      assert.equal((await other.listTrash()).entries.length, 0);
      assert.equal(await exists(join(remote.claude, "projects", PROJECT, `${remoteId}.jsonl`)), true);
      assert.equal((await other.previewDelete([key(localId)])).items[0].blocked, "not_found", "keys from one host mean nothing on another");
      assert.notDeepEqual(hostKey("local", "list"), hostKey("remote", "list"));
    } finally {
      await remote.cleanup();
    }
  });

  it("leaves an unreadable sessions index untouched", async () => {
    const id = await writeFullSession(host, PROJECT);
    const indexPath = join(host.claude, "projects", PROJECT, "sessions-index.json");
    await writeFileDeep(indexPath, "{ broken");
    const m = manager(host);
    const preview = await m.previewDelete([key(id)]);
    assert.equal((await m.deleteSessions([{ key: key(id), fingerprint: preview.items[0].fingerprint }])).results[0].ok, true);
    assert.equal(await readFile(indexPath, "utf8"), "{ broken");
  });

  it("ages files beyond the recent window before deleting them", async () => {
    const id = await writeFullSession(host, PROJECT);
    const m = manager(host, { recentMs: 60_000 });
    assert.equal((await m.previewDelete([key(id)])).items[0].blocked, "recent");
    const walk = async (path: string): Promise<void> => {
      const info = await lstat(path);
      if (info.isDirectory()) for (const name of await readdir(path)) await walk(join(path, name));
      await age(path);
    };
    await walk(join(host.claude, "projects"));
    await walk(join(host.claude, "todos"));
    await walk(join(host.claude, "file-history"));
    await walk(join(host.claude, "session-env"));
    await walk(join(host.claude, "debug"));
    assert.equal((await m.previewDelete([key(id)])).items[0].blocked, null);
  });
});

describe("roots and helpers", () => {
  it("discovers Claude, Codex, and Antigravity roots from env, defaults, and Paseo provider profiles", async () => {
    const host = await makeHost("roots");
    try {
      const home = join(host.base, "home");
      const claudeProfile = join(host.base, "work-claude");
      const codexProfile = join(host.base, "work-codex");
      await mkdir(join(home, ".claude", "projects"), { recursive: true });
      await mkdir(join(home, ".codex", "sessions"), { recursive: true });
      await mkdir(join(home, ".gemini", "antigravity-cli", "conversations"), { recursive: true });
      await mkdir(join(claudeProfile, "projects"), { recursive: true });
      await mkdir(join(codexProfile, "sessions"), { recursive: true });
      await writeFileDeep(
        join(host.paseo, "config.json"),
        JSON.stringify({
          agents: {
            providers: {
              workClaude: { env: { CLAUDE_CONFIG_DIR: claudeProfile, ANTHROPIC_API_KEY: "never-read" } },
              workCodex: { env: { CODEX_HOME: codexProfile, OPENAI_API_KEY: "never-read" } },
              dup: { env: { CLAUDE_CONFIG_DIR: host.claude } },
              missing: { env: { CLAUDE_CONFIG_DIR: join(host.base, "nope") } },
            },
          },
        }),
      );
      const roots = await discoverRoots({
        env: { CLAUDE_CONFIG_DIR: host.claude, CODEX_HOME: host.codex, ANTIGRAVITY_DATA_DIR: host.antigravity },
        home,
        paseoHome: host.paseo,
      });
      assert.deepEqual(
        roots.map((root) => [root.provider, root.real, root.source]),
        [
          ["claude", host.claude, "env"],
          ["claude", join(home, ".claude"), "default"],
          ["claude", claudeProfile, "paseo-provider"],
          ["codex", host.codex, "env"],
          ["codex", join(home, ".codex"), "default"],
          ["codex", codexProfile, "paseo-provider"],
          ["antigravity", host.antigravity, "env"],
          ["antigravity", join(home, ".gemini", "antigravity-cli"), "default"],
        ],
      );
      assert.equal(roots[0].id, rootId(host.claude, "claude"));
      assert.equal(roots[3].id, rootId(host.codex, "codex"));
      assert.equal(roots[6].id, rootId(host.antigravity, "antigravity"));
    } finally {
      await host.cleanup();
    }
  });

  it("builds resume commands for Claude Code, Codex, and Antigravity with safe quoting", () => {
    assert.equal(
      resumeCommand({ provider: "claude", sessionId: "abc-1", cwd: "/work/app", rootPath: "/home/u/.claude", isDefaultRoot: true }),
      "cd /work/app && claude --resume abc-1",
    );
    assert.equal(
      resumeCommand({ provider: "claude", sessionId: "abc-1", cwd: "/work/it's here", rootPath: "/srv/claude work", isDefaultRoot: false }),
      `cd '/work/it'\\''s here' && CLAUDE_CONFIG_DIR='/srv/claude work' claude --resume abc-1`,
    );
    assert.equal(
      resumeCommand({ provider: "codex", sessionId: "01a2-codex", cwd: "/work/app", rootPath: "/home/u/.codex", isDefaultRoot: true }),
      "cd /work/app && codex resume 01a2-codex",
    );
    assert.equal(
      resumeCommand({ provider: "codex", sessionId: "01a2-codex", cwd: "/work/app", rootPath: "/srv/codex work", isDefaultRoot: false }),
      `cd /work/app && CODEX_HOME='/srv/codex work' codex resume 01a2-codex`,
    );
    assert.equal(
      resumeCommand({ provider: "antigravity", sessionId: "agy-99", cwd: "/work/app", rootPath: "/home/u/.gemini/antigravity-cli", isDefaultRoot: true }),
      "cd /work/app && agy --conversation agy-99",
    );
    assert.equal(
      resumeCommand({ provider: "antigravity", sessionId: "agy-99", cwd: "", rootPath: "/r", isDefaultRoot: true }),
      "agy --conversation agy-99",
    );
  });
});
