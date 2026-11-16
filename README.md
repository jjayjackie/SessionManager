# Claude session manager

[简体中文](./README.zh-CN.md)

A [Paseo](https://paseo.sh) plugin for managing **native Claude Code session history** on every
Paseo host: browse, search, inspect, copy a resume command, delete to a trash, restore, and purge.
It reads `~/.claude/projects/` directly (and every other Claude configuration directory, see below),
so it covers sessions started in a terminal, an IDE, or by Paseo alike.

Derived from [`session-usage`](https://github.com/panrafal/paseo-plugins/tree/main/session-usage)
by panrafal (MIT). The Claude directory discovery and the Paseo agent-record reader are adapted from
it; the scanner, deletion engine, trash, and UI are new.

## Features

- **Every Claude directory on the host**: `$CLAUDE_CONFIG_DIR`, `~/.claude`, and each Paseo provider
  profile whose environment sets `CLAUDE_CONFIG_DIR` (separate accounts), deduplicated by physical path.
- **Project navigation**: sessions grouped by Claude project directory, labelled with the recorded
  working directory, with per-project counts that follow the active search.
- **Full-text search** over titles, prompts, and Claude's replies (AND of all words), plus session ID,
  path, and branch. Results show the matching snippet.
- **Filters and sorting**: status (in use / idle), health (healthy / damaged / empty), origin
  (started in Paseo / native), sort by last activity, start, size, messages, or title; pagination.
- **Details**: title source, working directory, branch, timing, message counts, size, Claude Code
  version, models, the exact files a delete would move, duplicate session IDs, resumed or forked
  copies (sessions that share message UUIDs), and a short conversation preview.
- **Resume command** with correct shell quoting, `cd` into the recorded directory, and
  `CLAUDE_CONFIG_DIR=` for non-default directories. One-tap copy.
- **Single and bulk delete** with a host-side preview, a confirmation dialog, and per-session results.
- **Trash**: restore (all-or-nothing per session), permanent delete of selected entries, or empty
  the trash, each with confirmation.
- **Paseo native**: a screen with Paseo's host picker, a sidebar row, a Command Center item, theme
  tokens for light and dark themes, responsive three-, two-, and one-column layouts, Paseo modals
  (bottom sheets on phones), toasts, and clipboard.
- **Simplified Chinese and English**, following the Paseo app language.

## Install

Requires **Paseo 0.13.0 or later** on both the daemon and the app (plugin translations, screens, and
the `client/ui` kit). Plugins must be enabled under **Settings → Plugins**.

Install on each host whose sessions you want to manage (the plugin runs on that host's daemon):

```bash
paseo plugin add git:jjayjackie/paseo-plugins:claude-session-manager
# a specific release or branch
paseo plugin add git:jjayjackie/paseo-plugins:claude-session-manager --ref claude-session-manager-v0.1.0
# a remote daemon
paseo --host <url> plugin add git:jjayjackie/paseo-plugins:claude-session-manager
```

Or download `claude-session-manager-<version>.tar.gz` from the
[releases](https://github.com/jjayjackie/paseo-plugins/releases), extract it on the daemon machine,
and run `paseo plugin install /absolute/path/to/claude-session-manager`. You can also paste either
source into **Settings → Plugins → Plugin source**.

The plugin has no runtime dependencies; Paseo supplies React, React Native, TanStack Query, Zod, and
the SDK. Check `paseo plugin ls` for `running`, then open **Claude sessions** in the sidebar or from
the Command Center (⌘K / Ctrl+K).

## What a delete touches

A delete moves these, and only these, into the trash:

| Location (inside the Claude directory) | When |
| --- | --- |
| `projects/<dir>/<id>.jsonl` | always (the transcript `/resume` lists) |
| `projects/<dir>/<id>/` | when present (subagent transcripts, tool results) |
| `projects/<dir>/agent-*.jsonl` whose `sessionId` is `<id>` | older subagent layout |
| `todos/<id>.json`, `todos/<id>-agent-*.json`, `file-history/<id>/`, `session-env/<id>/`, `debug/<id>.txt`, `tasks/<id>/` | only when no other transcript in the same directory uses the same session ID |

If `projects/<dir>/sessions-index.json` exists (a `/resume` summary cache in some Claude Code
versions), the session's entries are removed from it and put back on restore; unknown fields are
kept and an unreadable index is left alone. Claude Code builds `/resume` from the transcripts, so a
trashed session no longer appears there.

Never touched: `settings*.json`, `.credentials.json`, `~/.claude.json`, `history.jsonl` (prompt
history shared by all sessions and appended to concurrently), `CLAUDE.md`, `skills/`, `plugins/`,
`agents/`, `commands/`, MCP configuration, `projects/<dir>/memory/`, and anything outside the
Claude directory, including your source code.

The trash lives on the same host at `$PASEO_HOME/plugin-data/claude-session-manager/trash/`
(mode `0700`). Each entry holds the moved files and a manifest of their original relative paths.

## Safety model

- **Server-side only.** The app sends opaque session keys; the daemon resolves them against its own
  scan. No client-supplied path ever reaches the filesystem.
- **Fixed allowlist.** Paths are computed from the table above and must sit below a managed
  top-level folder (`projects`, `todos`, `file-history`, `session-env`, `debug`, `tasks`). Symbolic
  links are never followed or moved; a top-level folder that is itself a link (for example
  `projects` on another disk) is supported.
- **Running sessions are protected.** A delete is refused while Claude Code's process registry
  (`<config dir>/sessions/<pid>.json`) names the session and the process is alive, while a Paseo
  agent bound to it is running or initializing, or within 90 seconds of its last write.
- **Preview fingerprint.** Confirming sends back a fingerprint of the files the preview listed; if
  anything changed in between (the session was resumed, another client deleted it), the session is
  skipped with "changed" or "not found".
- **One mutation at a time per host**, so concurrent clients cannot interleave deletes and restores.
- **Transactional moves.** A failure part-way through moves already-moved files back. Restores check
  every target first and never overwrite; an edited manifest cannot write outside a configured
  Claude directory.
- **Duplicate session IDs** (a transcript copied to another project directory) are listed
  separately; shared per-ID files stay until the last copy is deleted. Sessions that share message
  UUIDs (resumed or forked copies) are shown as related; each transcript is self-contained, so
  deleting one never affects another.
- **Damaged transcripts** (unparseable lines) are flagged, counted, and still listable, deletable,
  and restorable.
- Search text is held in memory only, never written to disk, and dropped when a transcript disappears.

## Remote hosts

Paseo installs plugins per daemon. With the plugin on several hosts, the screen header shows Paseo's
host picker; the selected host runs every scan, read, delete, and restore through the official
plugin RPC, and each host has its own catalog and trash. The UI remounts when the host changes,
query keys include the host ID, and an offline host shows its last data with a banner instead of
falling through to another host. After a reconnect, polling and Paseo's retained query cache
refresh the view. No extra server or port is opened.

## SDK usage and compatibility

Everything uses the public Paseo plugin SDK: `addScreen`, `addSidebarHeaderItem`,
`addCommandCenterItem`, `defineRpc` / `server.handle` / `useRpc`, `useHosts`,
`defineTranslations` / `useTranslation` / `messages.message`, and `Icon`, `Modal`, `ScrollView`,
`TextInput`, `useToast`, `copyText`, `SidebarRow` from `@getpaseo/plugin/client/ui`.

Gaps and the approach taken:

- **No locale-aware date API in the SDK.** Dates use `Intl.DateTimeFormat` / `Intl.RelativeTimeFormat`
  with the locale reported by `useTranslation`.
- **No checkbox, select, or badge components in the SDK.** They are built from React Native
  primitives, colored only with `theme.colors`, and the select opens Paseo's `Modal`.
- **No live "is this agent running" lookup by Claude session ID.** Running state comes from Claude
  Code's process registry plus Paseo's agent records on disk (the approach upstream `session-usage`
  uses), with the 90-second write window as a fallback.
- **Plugin RPC has no cross-host form**, so the plugin relies on Paseo's host picker instead of
  aggregating hosts; install it on each host.
- `useSubscription` (push updates) exists only from Paseo 0.16, so the screen polls (every 30 s,
  every 1.5 s during the first scan) to stay compatible with 0.13.

## Development

Builds, installs, typechecks, lint, tests, audits, and packaging run only in
[GitHub Actions](../.github/workflows/claude-session-manager.yml) on GitHub-hosted runners:

| Step | Command |
| --- | --- |
| Boundary and safety audit (runtime boundaries, DOM use, hardcoded colors, secrets, transcripts) | `npm run audit` |
| Typecheck, client and server separately | `npm run typecheck` |
| ESLint (TypeScript, React hooks) | `npm run lint` |
| Tests with synthetic sessions in temporary directories | `npm test` |
| esbuild bundle of both entries, as Paseo compiles plugins | `npm run bundle:check` |
| Runtime dependency audit | `npm audit --omit=dev` |
| CodeQL | separate job |

Pushes and pull requests run the matrix (Ubuntu with Node 22 and 24, macOS with Node 22). A passing
run uploads the packaged plugin. Pushing a tag `claude-session-manager-v<version>` that matches
`package.json` publishes a GitHub release with the archives and `SHA256SUMS.txt`.

The tests cover listing, parsing, search, filters, pagination, the exact file set a delete moves,
untouched configuration and source files, byte-identical restore, restore conflicts, running,
recent, and Paseo-agent protection, preview fingerprints, concurrent deletes, duplicate IDs, forked
copies, symbolic links, tampered manifests, unknown directories, input validation, host isolation,
root discovery, resume quoting, and translation resources.

### Not verifiable in CI

These need a real Paseo app and daemon and are verified by hand:

- rendering in the Paseo app on desktop, web, iOS, and Android, in light and dark themes;
- the host picker with two or more hosts, and an offline host and reconnect;
- the language switch between English and Simplified Chinese in a running app;
- `/resume` in a real Claude Code install no longer listing a trashed session, and listing it again
  after restore;
- detection through a real Claude Code process registry and live Paseo agents.

## Limitations

- Only Claude Code sessions are managed; other providers are out of scope.
- `history.jsonl` (the up-arrow prompt history) keeps prompts of deleted sessions by design.
- The trash does not expire automatically; empty it from the Trash tab.
- Full-text search indexes up to 256 KB of prompts and replies per session; tool output is not indexed.

## License

MIT. See [LICENSE](./LICENSE). Original work © panrafal; this plugin © jjayjackie.
