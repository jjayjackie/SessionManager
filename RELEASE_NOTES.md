SessionManager for Paseo: browse, search, delete, and restore native Claude Code, Codex, and Antigravity sessions on each host.

- Renamed from ClaudeSession (`claude-session-manager`) to SessionManager (`session-manager`).
- Added native **Codex** session support: scans `$CODEX_HOME`, `~/.codex`, and Paseo provider profiles (`sessions/` and `archived_sessions/` rollouts), parses prompts/replies/models/branch/version, generates `codex resume` commands, syncs `session_index.jsonl`, and safely trashes/restores rollout + capability + shell snapshot artifacts.
- Added native **Antigravity** session support: scans `$ANTIGRAVITY_DATA_DIR`, `$ANTIGRAVITY_CLI_DIR`, `~/.gemini/antigravity-cli`, `~/.gemini/antigravity`, and Paseo provider profiles, parses `conversation_metadata.json` and `brain/<id>/.system_generated/logs/transcript.jsonl`, detects active SQLite WAL locks, generates `agy --conversation` commands, syncs cache metadata, and safely trashes/restores conversation DB + brain + annotation + presence files.
- Unified cross-provider project grouping: sessions from Claude Code, Codex, and Antigravity sharing the same working directory merge into a single project entry with per-provider indicators.
- Redesigned Paseo client UI in a clean industrial style: compact top command bar, live telemetry strip, provider segmented filter with counts, tight hairline borders, monospace metadata spec sheet, 2×2 metric cards, and structured conversation preview — 100% built from Paseo theme tokens.
- Updated README (with centered top icon), registry overviews, and English / Simplified Chinese translations. Requires Paseo 0.13.0 or later.

Install: `paseo plugin add git:jjayjackie/SessionManager`, or extract the archive below on the daemon machine and run `paseo plugin install <path>`.
Verify downloads with `SHA256SUMS.txt`.
