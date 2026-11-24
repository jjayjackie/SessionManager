import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { extractAntigravityUserText, parseAntigravityTranscript, readAntigravityMetadata, readAntigravityPreview } from "./antigravity-parser";
import { extractCodexSessionId, parseCodexRollout, readCodexPreview } from "./codex-parser";
import { firstSessionId, parseTranscript, readPreview } from "./parser";
import { assistant, makeHost, nextTime, user, writeFileDeep, writeFullAntigravitySession, writeFullCodexSession, writeTranscript, type FakeHost } from "./testkit";

describe("transcript parsers", () => {
  let host: FakeHost;
  before(async () => {
    host = await makeHost("parser");
  });
  after(async () => {
    await host.cleanup();
  });

  it("prefers custom title, then AI title, then summary, then the first real prompt (Claude)", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const base = [user(id, "<command-name>/clear</command-name>"), user(id, "Refactor the parser"), assistant(id, "Done")];
    let parsed = await parseTranscript(await writeTranscript(host, "p", id, base));
    assert.equal(parsed.firstPrompt, "Refactor the parser");
    assert.equal(parsed.customTitle, "");
    parsed = await parseTranscript(await writeTranscript(host, "p", id, [...base, { type: "summary", summary: "Parser work", leafUuid: "x" }]));
    assert.equal(parsed.summary, "Parser work");
    parsed = await parseTranscript(await writeTranscript(host, "p", id, [...base, { type: "ai-title", aiTitle: "AI title", sessionId: id }, { type: "custom-title", customTitle: "Mine", sessionId: id }]));
    assert.equal(parsed.customTitle, "Mine");
    assert.equal(parsed.aiTitle, "AI title");
  });

  it("counts messages, skips tool results and meta records, and records metadata (Claude)", async () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const parsed = await parseTranscript(
      await writeTranscript(host, "p", id, [
        user(id, "Hello"),
        user(id, [{ type: "tool_result", tool_use_id: "t", content: "SECRET TOOL OUTPUT" }]),
        user(id, "meta", { isMeta: true }),
        assistant(id, "Hi there"),
        { type: "file-history-snapshot", messageId: "m", snapshot: {} },
      ]),
    );
    assert.equal(parsed.userMessages, 1);
    assert.equal(parsed.assistantMessages, 1);
    assert.equal(parsed.cwd, "/work/app");
    assert.equal(parsed.gitBranch, "main");
    assert.deepEqual(parsed.models, ["claude-opus-5-5"]);
    assert.ok(parsed.searchText.includes("hi there"));
    assert.ok(!parsed.searchText.includes("secret tool output"), "tool output is not indexed");
    assert.ok(parsed.startedAt && parsed.endedAt && parsed.startedAt < parsed.endedAt);
  });

  it("counts damaged lines without failing and reports repeated message IDs (Claude)", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const message = user(id, "Repeated");
    const parsed = await parseTranscript(await writeTranscript(host, "p", id, [message, "{not json", "[1,2]", message, assistant(id, "ok"), '{"type":"user","truncated']));
    assert.equal(parsed.badLines, 3);
    assert.equal(parsed.duplicateUuids, 1);
    assert.equal(parsed.assistantMessages, 1);
  });

  it("reads the parent session ID of a legacy agent file and builds a preview (Claude)", async () => {
    const id = "44444444-4444-4444-8444-444444444444";
    const path = join(host.claude, "projects", "p", "agent-abc.jsonl");
    await writeFileDeep(path, `garbage\n${JSON.stringify(user(id, "sub", { isSidechain: true }))}\n`);
    assert.equal(await firstSessionId(path), id);
    const transcript = await writeTranscript(host, "p", id, [user(id, "one"), assistant(id, "two"), user(id, "three"), assistant(id, "four"), user(id, "five"), assistant(id, "six")]);
    const preview = await readPreview(transcript, 2, 2);
    assert.deepEqual(preview.map((m) => m.text), ["one", "two", "five", "six"]);
  });

  it("parses Codex rollouts, skips synthetic wrappers, and builds previews", async () => {
    const id = "55555555-5555-4555-8555-555555555555";
    assert.equal(extractCodexSessionId(`rollout-2026-11-24T04-06-51-${id}.jsonl`), id);
    const { rolloutPath } = await writeFullCodexSession(host, {
      sessionId: id,
      cwd: "/work/codex-app",
      prompt: "Build the CLI wrapper",
      reply: "Implemented CLI wrapper in src/cli.ts",
      branch: "release/1.2",
    });
    const parsed = await parseCodexRollout(rolloutPath);
    assert.equal(parsed.cwd, "/work/codex-app");
    assert.equal(parsed.gitBranch, "release/1.2");
    assert.equal(parsed.version, "0.172.0");
    assert.deepEqual(parsed.models, ["gpt-5.3-codex"]);
    assert.equal(parsed.firstPrompt, "Build the CLI wrapper");
    assert.equal(parsed.userMessages, 1);
    assert.equal(parsed.assistantMessages, 1);
    assert.ok(!parsed.searchText.includes("environment_context"));
    const preview = await readCodexPreview(rolloutPath);
    assert.deepEqual(preview.map((m) => [m.role, m.text]), [
      ["user", "Build the CLI wrapper"],
      ["assistant", "Implemented CLI wrapper in src/cli.ts"],
    ]);
  });

  it("falls back to Codex event_msg records when response_item messages are absent", async () => {
    const id = "66666666-6666-4666-8666-666666666666";
    const rolloutPath = join(host.codex, "sessions", "2026", "11", "24", `rollout-2026-11-24T05-00-00-${id}.jsonl`);
    await writeFileDeep(
      rolloutPath,
      [
        JSON.stringify({ timestamp: nextTime(), type: "session_meta", payload: { id, cwd: "/work/events" } }),
        JSON.stringify({ timestamp: nextTime(), type: "event_msg", payload: { type: "user_message", message: "Inspect event stream" } }),
        JSON.stringify({ timestamp: nextTime(), type: "event_msg", payload: { type: "agent_message", message: "Event stream looks clean." } }),
        "{broken-line",
      ].join("\n") + "\n",
    );
    const parsed = await parseCodexRollout(rolloutPath);
    assert.equal(parsed.userMessages, 1);
    assert.equal(parsed.assistantMessages, 1);
    assert.equal(parsed.firstPrompt, "Inspect event stream");
    assert.equal(parsed.badLines, 1);
    const preview = await readCodexPreview(rolloutPath);
    assert.equal(preview.length, 2);
  });

  it("parses Antigravity metadata, strips USER_REQUEST envelopes, counts subagents, and builds previews", async () => {
    assert.equal(extractAntigravityUserText("<USER_REQUEST>\nHello AGY\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>"), "Hello AGY");
    const id = await writeFullAntigravitySession(host, {
      cwd: "/work/agy-app",
      title: "Migrate SQLite index",
      prompt: "Migrate the SQLite index cleanly",
      reply: "Migration completed without downtime.",
    });
    const metadata = await readAntigravityMetadata(host.antigravity);
    const meta = metadata.get(id);
    assert.ok(meta);
    assert.equal(meta.title, "Migrate SQLite index");
    assert.equal(meta.cwd, "/work/agy-app");
    const txPath = join(host.antigravity, "brain", id, ".system_generated", "logs", "transcript.jsonl");
    const { parsed, subagentCount } = await parseAntigravityTranscript(txPath, id, meta);
    assert.equal(parsed.aiTitle, "Migrate SQLite index");
    assert.equal(parsed.firstPrompt, "Migrate the SQLite index cleanly");
    assert.equal(parsed.userMessages, 1);
    assert.equal(parsed.assistantMessages, 1);
    assert.deepEqual(parsed.models, ["gemini-4-neon-high"]);
    assert.equal(subagentCount, 1);
    assert.ok(!parsed.searchText.includes("internal reasoning"));
    const preview = await readAntigravityPreview(txPath);
    assert.deepEqual(preview.map((m) => [m.role, m.text]), [
      ["user", "Migrate the SQLite index cleanly"],
      ["assistant", "Migration completed without downtime."],
    ]);
  });
});
