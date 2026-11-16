import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { hostKey, resumeCommand } from "../shared/format";
import { DeleteInputSchema, PurgeInputSchema, RestoreInputSchema } from "../shared/schema";
import { discoverRoots, rootId } from "./roots";
import { sessionKey } from "./scanner";
import { assistant, age, digest, encodeProject, makeHost, manager, query, tree, user, writeFileDeep, writeFullSession, writeSentinels, writeTranscript, type FakeHost } from "./testkit";

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

  const key = (sessionId: string, project = PROJECT) => sessionKey(host.root.id, project, sessionId);

  it("lists sessions grouped by project, with subagents, legacy agents, and Claude-owned folders ignored", async () => {
    const a = await writeFullSession(host, PROJECT);
    const b = randomUUID();
    await writeTranscript(host, OTHER, b, [user(b, "Write docs", { cwd: "/work/other" }), assistant(b, "Sure")]);
    await writeFileDeep(join(host.claude, "projects", OTHER, "agent-legacy1.jsonl"), `${JSON.stringify(user(b, "legacy subtask", { isSidechain: true }))}\n`);
    await writeFileDeep(join(host.claude, "projects", PROJECT, "memory", "MEMORY.md"), "memory");
    await writeFileDeep(join(host.claude, "projects", PROJECT, "sessions-index.json"), JSON.stringify({ version: 1, entries: [] }));
    await writeFileDeep(join(host.claude, "projects", PROJECT, "notes.txt"), "not a session");
    const result = await manager(host).list(query());
    assert.equal(result.total, 2);
    assert.equal(result.stats.projects, 2);
    const first = result.items.find((item) => item.sessionId === a);
    const second = result.items.find((item) => item.sessionId === b);
    assert.ok(first && second);
    assert.equal(first.title, "Fix the login bug");
    assert.equal(first.titleSource, "custom");
    assert.equal(first.subagentCount, 1);
    assert.equal(second.subagentCount, 1, "legacy agent-*.jsonl is attached by its sessionId");
    assert.deepEqual(result.projects.map((project) => project.path).sort(), ["/work/app", "/work/other"]);
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
    assert.equal((await m.list(query({ projectKey: `${host.root.id}/${OTHER}` }))).total, 0);
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

  it("moves exactly the session's artifacts to the trash and never touches configuration or source", async () => {
    const id = await writeFullSession(host, PROJECT);
    const keep = await writeFullSession(host, PROJECT, randomUUID(), "Keep me");
    const sentinels = await writeSentinels(host, PROJECT);
    await writeFileDeep(join(host.claude, "projects", PROJECT, "sessions-index.json"), JSON.stringify({ version: 1, originalPath: "/work/app", entries: [{ sessionId: id, summary: "x" }, { sessionId: keep, summary: "y" }] }));
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

  it("restores a deleted session byte for byte, including its index entry", async () => {
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
    await writeFileDeep(join(host.paseo, "agents", "ws1", "agent-1.json"), JSON.stringify({ id: "agent-1", provider: "claude", title: "Paseo agent", lastStatus: "running", createdAt: "2026-01-01", persistence: { sessionId: paseo, metadata: { token: "secret" } } }));
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

  it("never follows symbolic links out of the Claude directory", async () => {
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

  it("rejects tampered trash manifests and unknown Claude directories on restore", async () => {
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
      const foreign = manager(host, { roots: async () => [elsewhere.root] });
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

  it("isolates hosts: separate Claude directories, catalogs, and trash", async () => {
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
  it("honours CLAUDE_CONFIG_DIR and Paseo provider profiles, deduplicating by physical path", async () => {
    const host = await makeHost("roots");
    try {
      const home = join(host.base, "home");
      const profile = join(host.base, "work-account");
      await mkdir(join(home, ".claude", "projects"), { recursive: true });
      await mkdir(join(profile, "projects"), { recursive: true });
      await writeFileDeep(join(host.paseo, "config.json"), JSON.stringify({ agents: { providers: { work: { env: { CLAUDE_CONFIG_DIR: profile, ANTHROPIC_API_KEY: "never-read" } }, dup: { env: { CLAUDE_CONFIG_DIR: host.claude } }, missing: { env: { CLAUDE_CONFIG_DIR: join(host.base, "nope") } } } } }));
      const roots = await discoverRoots({ env: { CLAUDE_CONFIG_DIR: host.claude }, home, paseoHome: host.paseo });
      assert.deepEqual(roots.map((root) => [root.real, root.source]), [[host.claude, "env"], [join(home, ".claude"), "default"], [profile, "paseo-provider"]]);
      assert.equal(roots[1].isDefault, true);
      assert.equal(roots[0].id, rootId(host.claude));
    } finally {
      await host.cleanup();
    }
  });

  it("builds resume commands with safe quoting and the right configuration directory", () => {
    assert.equal(resumeCommand({ sessionId: "abc-1", cwd: "/work/app", rootPath: "/home/u/.claude", isDefaultRoot: true }), "cd /work/app && claude --resume abc-1");
    assert.equal(
      resumeCommand({ sessionId: "abc-1", cwd: "/work/it's here", rootPath: "/srv/claude work", isDefaultRoot: false }),
      `cd '/work/it'\\''s here' && CLAUDE_CONFIG_DIR='/srv/claude work' claude --resume abc-1`,
    );
    assert.equal(resumeCommand({ sessionId: "x", cwd: "", rootPath: "/r", isDefaultRoot: true }), "claude --resume x");
  });
});
