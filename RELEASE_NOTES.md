SessionManager 0.2.1 for Paseo: official brand logos, brand-matched accents, and cleaner Antigravity session discovery.

- Replaced text provider tags and generic colored dots with official inline SVG logos and signature brand colors across the provider switcher, unified project rail, session list, inspector header, conversation preview, trash view, and delete dialog:
  - **Claude Code**: Anthropic starburst (`#D97757`)
  - **Codex**: OpenAI knot (`#10A37F`)
  - **Antigravity**: Google Antigravity arch (`#4285F4`)
- Adapted to Antigravity's native storage lifecycle:
  - Reads `conversation_summaries.db` (read-only via built-in `node:sqlite` when available) merged with `cache/conversation_metadata.json` so workspace directories and titles stay accurate even before the JSON cache flushes.
  - Automatically skips Antigravity's pre-allocated 0-step empty placeholder shells (384 KB DBs created on workspace startup before any prompt is sent) and internal trajectories so phantom untitled sessions no longer clutter the list or project sidebar.
- Added SVG asset safety checks to `scripts/audit-boundaries.mjs` and `.svg` text bundling to `scripts/bundle-check.mjs` matching Paseo's plugin compiler.

Install: `paseo plugin add git:jjayjackie/SessionManager`, or extract the archive below on the daemon machine and run `paseo plugin install <path>`.
Verify downloads with `SHA256SUMS.txt`.
