SessionManager 0.2.2 for Paseo: sidebar bug fix, custom outline icon, multi-agent metadata enrichment, and full-stack performance optimizations.

- **Fixed Paseo sidebar double-highlight bug**: changed the plugin screen ID from `sessions` to `manager` so opening SessionManager no longer triggers Paseo's built-in History row (`pathname.includes("/sessions")`).
- **Custom SessionManager outline icon**: added a dedicated monochrome `currentColor` SVG icon (`client/icons/session-manager.svg`) derived from `assets/icon.png` (stacked session cards + terminal prompt) for the Paseo sidebar, Command Center, and screen header, eliminating visual duplication with Paseo's built-in History icon.
- **Multi-agent accuracy & liveness improvements**:
  - Enriches Codex rollouts with read-only `state_<n>.sqlite` metadata (titles, branch, model, cwd, CLI version) even when `session_index.jsonl` is empty, and aligns `thread-writer-locks/*.lock` recency consistently across list, detail, and delete preview.
  - Protects Antigravity sessions marked active/running (`not_fully_idle = 1` or running status) in `conversation_summaries.db` in addition to open `.db-wal`/`.db-shm` files.
- **Daemon & client performance optimizations**:
  - Caches recursive `treeSize` & subagent counts per session directory across background scans, runs root liveness checks in parallel, raises parse concurrency to 8, caches trash stats between mutations, and pre-indexes session summaries & metadata haystacks to eliminate per-keystroke string allocations.
  - Fast-skips non-conversational lines before `JSON.parse` when streaming previews for Claude, Codex, and Antigravity transcripts, and normalizes/caps per-session search text at 128 KB to reduce daemon memory footprint.
  - Isolates `SearchBox` state in the React Native client so typing never re-renders the project rail, session list, or inspector; memoizes options, callbacks, and child panes; adds `staleTime: 10s` on list/detail/trash queries; caps host preference memory to 32 hosts; adapts 3-pane widths for 1080–1279px screens.

Install: `paseo plugin add git:jjayjackie/SessionManager`, or extract the archive below on the daemon machine and run `paseo plugin install <path>`.
Verify downloads with `SHA256SUMS.txt`.
