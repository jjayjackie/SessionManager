Manage the Claude Code session history stored on a Paseo host, including sessions started outside Paseo. Browse sessions by project, search titles, prompts, and replies, inspect a session, copy its resume command, and move sessions to a trash from which they can be restored or deleted permanently.

The plugin reads every Claude configuration directory on the host: `CLAUDE_CONFIG_DIR`, `~/.claude`, and the directories of Paseo provider profiles. Each host runs its own scan and keeps its own trash; use the host picker in the screen header to switch hosts.

Deleting moves only the session transcript, its subagent and tool-result folder, and per-session files such as todos and file checkpoints. Settings, credentials, prompt history, skills, MCP configuration, project memory, and source files are never changed. Sessions that a live Claude Code process or a running Paseo agent is using, or that were written in the last 90 seconds, cannot be deleted. Trashed sessions no longer appear in Claude Code's `/resume`.

The trash is stored under the Paseo home on the same host. Requires Paseo 0.13 or later. English and Simplified Chinese follow the app language.
