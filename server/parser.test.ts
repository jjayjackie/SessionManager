import assert from "node:assert/strict";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { firstSessionId, parseTranscript, readPreview } from "./parser";
import { assistant, makeHost, user, writeFileDeep, writeTranscript, type FakeHost } from "./testkit";

describe("transcript parser", () => {
  let host: FakeHost;
  before(async () => {
    host = await makeHost("parser");
  });
  after(async () => {
    await host.cleanup();
  });

  it("prefers custom title, then AI title, then summary, then the first real prompt", async () => {
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

  it("counts messages, skips tool results and meta records, and records metadata", async () => {
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

  it("counts damaged lines without failing and reports repeated message IDs", async () => {
    const id = "33333333-3333-4333-8333-333333333333";
    const message = user(id, "Repeated");
    const parsed = await parseTranscript(await writeTranscript(host, "p", id, [message, "{not json", "[1,2]", message, assistant(id, "ok"), '{"type":"user","truncated']));
    assert.equal(parsed.badLines, 3);
    assert.equal(parsed.duplicateUuids, 1);
    assert.equal(parsed.assistantMessages, 1);
  });

  it("reads the parent session ID of a legacy agent file and builds a preview", async () => {
    const id = "44444444-4444-4444-8444-444444444444";
    const path = join(host.claude, "projects", "p", "agent-abc.jsonl");
    await writeFileDeep(path, `garbage\n${JSON.stringify(user(id, "sub", { isSidechain: true }))}\n`);
    assert.equal(await firstSessionId(path), id);
    const transcript = await writeTranscript(host, "p", id, [user(id, "one"), assistant(id, "two"), user(id, "three"), assistant(id, "four"), user(id, "five"), assistant(id, "six")]);
    const preview = await readPreview(transcript, 2, 2);
    assert.deepEqual(preview.map((m) => m.text), ["one", "two", "five", "six"]);
  });
});
