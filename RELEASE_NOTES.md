Claude session manager for Paseo: browse, search, delete, and restore native Claude Code sessions on each host.

- Scans `$CLAUDE_CONFIG_DIR`, `~/.claude`, and Paseo provider profile directories.
- Project navigation, full-text search, filters, sorting, pagination, details, resume command.
- Single and bulk delete to a per-host trash with preview, confirmation, restore, and purge.
- Protects sessions used by a live Claude Code process, a running Paseo agent, or written in the last 90 seconds.
- Updates `sessions-index.json` so trashed sessions leave `/resume`; never touches settings, credentials, history, skills, MCP, memory, or source.
- English and Simplified Chinese. Requires Paseo 0.13.0 or later.

Install: `paseo plugin add git:jjayjackie/paseo-claude-session-manager`, or extract the archive below on the daemon machine and run `paseo plugin install <path>`.
Verify downloads with `SHA256SUMS.txt`.
