Manage native Claude Code, Codex, and Antigravity session history stored on each Paseo host, including sessions started outside Paseo. Browse sessions grouped by working directory across providers, switch between All, Claude Code, Codex, and Antigravity views, search titles, prompts, replies, paths, and IDs, inspect session metadata and disk artifacts, copy native resume commands, and move sessions to a per-host trash from which they can be restored or deleted permanently.

The plugin scans every configured agent data directory on the selected host:
- Claude Code: `CLAUDE_CONFIG_DIR`, `~/.claude`, and Paseo provider profiles.
- Codex: `CODEX_HOME`, `~/.codex`, and Paseo provider profiles.
- Antigravity: `ANTIGRAVITY_DATA_DIR`, `ANTIGRAVITY_CLI_DIR`, `~/.gemini/antigravity-cli`, `~/.gemini/antigravity`, and Paseo provider profiles.

Each host runs its own scan and maintains its own trash under `$PASEO_HOME/plugin-data/session-manager/trash/`; use Paseo's host picker to switch hosts. All data remains local to each host and its connected Paseo clients.

Deleting moves only allowlisted per-session files: Claude transcripts, session folders, legacy subagents, and per-ID artifacts; Codex rollouts, capability markers, and shell snapshots; Antigravity conversation databases, brain directories, annotations, and presence locks. Settings, credentials, prompt history, skills, plugins, MCP configuration, shared SQLite databases, project memory, and source code are never modified. Sessions used by a live Claude Code process, an open Antigravity WAL database, a running Paseo agent, or written in the last 90 seconds cannot be deleted.

Requires Paseo 0.13.0 or later. Supports English and Simplified Chinese following the Paseo app language. See the repository README for installation and development details.
