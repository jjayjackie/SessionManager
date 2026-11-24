import { z } from "zod";

/**
 * Language-neutral data exchanged between the daemon-side scanner and the app.
 * Every human-readable label is translated on the client; the server only sends codes.
 */

export const PROVIDERS = ["claude", "codex", "antigravity"] as const;
export const ProviderSchema = z.enum(PROVIDERS);
export type ProviderId = z.infer<typeof ProviderSchema>;
export const ProviderFilterSchema = z.enum(["all", ...PROVIDERS]);
export type ProviderFilter = z.infer<typeof ProviderFilterSchema>;

/** Why an action on a session or trash entry did not happen. */
export const ReasonCodeSchema = z.enum([
  "running", // a live agent process or active database lock owns the session
  "recent", // the session files were written moments ago; they may still be in use
  "paseo_running", // a Paseo agent bound to this session is running
  "not_found", // the session or trash entry no longer exists
  "changed", // files changed after the delete preview; preview again
  "unsafe_path", // a path left the managed agent directory or is a symbolic link
  "conflict", // restoring would overwrite an existing file
  "root_unavailable", // the original agent data directory is not configured on this host any more
  "manifest_invalid", // a trash entry has an unreadable manifest
  "io_error", // the filesystem refused the operation
]);
export type ReasonCode = z.infer<typeof ReasonCodeSchema>;

export const WarningSchema = z.object({
  code: z.enum(["unreadable_dir", "unreadable_file", "index_invalid", "scan_failed"]),
  path: z.string(),
});
export type ScanWarning = z.infer<typeof WarningSchema>;

export const SessionStateSchema = z.enum(["running", "recent", "idle"]);
export type SessionState = z.infer<typeof SessionStateSchema>;
export const HealthSchema = z.enum(["ok", "damaged", "empty"]);
export type Health = z.infer<typeof HealthSchema>;
export const TitleSourceSchema = z.enum(["custom", "ai", "summary", "prompt", "none"]);

export const SessionSummarySchema = z.object({
  /** Opaque key resolved only against the daemon's own scan. */
  key: z.string(),
  provider: ProviderSchema,
  sessionId: z.string(),
  projectKey: z.string(),
  rootId: z.string(),
  title: z.string(),
  titleSource: TitleSourceSchema,
  firstPrompt: z.string(),
  cwd: z.string(),
  gitBranch: z.string(),
  startedAt: z.string().nullable(),
  updatedAt: z.string(),
  userMessages: z.number(),
  assistantMessages: z.number(),
  /** Transcript / conversation database plus per-session directories and subagents. */
  bytes: z.number(),
  subagentCount: z.number(),
  state: SessionStateSchema,
  health: HealthSchema,
  badLines: z.number(),
  /** Another session record with the same provider and session ID exists on this host. */
  duplicateId: z.boolean(),
  paseo: z.object({ agentId: z.string(), title: z.string(), archived: z.boolean() }).nullable(),
  /** Matching text around the first search hit, when a search is active. */
  snippet: z.string().nullable(),
});
export type SessionSummary = z.infer<typeof SessionSummarySchema>;

export const ProjectSummarySchema = z.object({
  key: z.string(),
  /** The working directory path, or a directory identifier when cwd is unrecorded. */
  path: z.string(),
  providers: z.array(ProviderSchema),
  sessions: z.number(),
  /** Sessions matching the active search and filters, ignoring the project filter. */
  matching: z.number(),
  bytes: z.number(),
  updatedAt: z.string().nullable(),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const RootSchema = z.object({
  id: z.string(),
  provider: ProviderSchema,
  path: z.string(),
  isDefault: z.boolean(),
  source: z.enum(["env", "default", "paseo-provider"]),
  available: z.boolean(),
  sessions: z.number(),
});
export type RootInfo = z.infer<typeof RootSchema>;

export const ProviderCountsSchema = z.object({
  claude: z.number(),
  codex: z.number(),
  antigravity: z.number(),
});
export type ProviderCounts = z.infer<typeof ProviderCountsSchema>;

export const StatsSchema = z.object({
  sessions: z.number(),
  projects: z.number(),
  bytes: z.number(),
  active: z.number(),
  damaged: z.number(),
  trashEntries: z.number(),
  trashBytes: z.number(),
  byProvider: ProviderCountsSchema,
});
export type Stats = z.infer<typeof StatsSchema>;

export const SORT_KEYS = ["updated", "started", "size", "messages", "title"] as const;
export const SortKeySchema = z.enum(SORT_KEYS);
export type SortKey = z.infer<typeof SortKeySchema>;
export const StateFilterSchema = z.enum(["all", "active", "idle"]);
export const HealthFilterSchema = z.enum(["all", "ok", "damaged", "empty"]);
export const OriginFilterSchema = z.enum(["all", "paseo", "native"]);
export type StateFilter = z.infer<typeof StateFilterSchema>;
export type HealthFilter = z.infer<typeof HealthFilterSchema>;
export type OriginFilter = z.infer<typeof OriginFilterSchema>;

export const PAGE_SIZES = [25, 50, 100] as const;
export const MAX_BATCH = 500;

export const ListInputSchema = z.object({
  provider: ProviderFilterSchema.default("all"),
  search: z.string().max(200).default(""),
  projectKey: z.string().max(600).nullable().default(null),
  state: StateFilterSchema.default("all"),
  health: HealthFilterSchema.default("all"),
  origin: OriginFilterSchema.default("all"),
  sort: SortKeySchema.default("updated"),
  direction: z.enum(["asc", "desc"]).default("desc"),
  page: z.number().int().min(0).max(100_000).default(0),
  pageSize: z.number().int().min(5).max(200).default(50),
  refresh: z.boolean().default(false),
});
export type ListInput = z.input<typeof ListInputSchema>;
export type ListQuery = z.output<typeof ListInputSchema>;

export const ListOutputSchema = z.object({
  roots: z.array(RootSchema),
  projects: z.array(ProjectSummarySchema),
  items: z.array(SessionSummarySchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
  stats: StatsSchema,
  scannedAt: z.string().nullable(),
  scanning: z.object({ done: z.number(), total: z.number() }).nullable(),
  warnings: z.array(WarningSchema),
});
export type ListOutput = z.infer<typeof ListOutputSchema>;

export const FileKindSchema = z.enum([
  "transcript",
  "session-dir",
  "legacy-subagent",
  "todo",
  "file-history",
  "session-env",
  "debug",
  "tasks",
  "rollout",
  "codex-capabilities",
  "shell-snapshot",
  "conversation-db",
  "brain-dir",
  "annotation",
  "presence",
]);
export type FileKind = z.infer<typeof FileKindSchema>;

export const PlannedFileSchema = z.object({
  /** Path relative to the provider data directory, with forward slashes. */
  path: z.string(),
  kind: FileKindSchema,
  bytes: z.number(),
});
export type PlannedFileInfo = z.infer<typeof PlannedFileSchema>;

export const PreviewMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  timestamp: z.string().nullable(),
});

export const DetailOutputSchema = z.object({
  session: SessionSummarySchema,
  rootPath: z.string(),
  isDefaultRoot: z.boolean(),
  transcriptPath: z.string(),
  version: z.string(),
  models: z.array(z.string()),
  files: z.array(PlannedFileSchema),
  /** Files shared by every transcript with this session ID; kept while a duplicate remains. */
  keptShared: z.array(PlannedFileSchema),
  duplicates: z.array(z.string()),
  /** Other sessions containing copies of this session's messages (resumed or forked). */
  related: z.array(z.object({ key: z.string(), title: z.string(), shared: z.number() })),
  duplicateUuids: z.number(),
  preview: z.array(PreviewMessageSchema),
  blocked: ReasonCodeSchema.nullable(),
});
export type DetailOutput = z.infer<typeof DetailOutputSchema>;

const KeysSchema = z.array(z.string().min(1).max(600)).min(1).max(MAX_BATCH);

export const PreviewInputSchema = z.object({ keys: KeysSchema });
export const PreviewItemSchema = z.object({
  key: z.string(),
  provider: ProviderSchema,
  title: z.string(),
  fingerprint: z.string(),
  files: z.array(PlannedFileSchema),
  bytes: z.number(),
  blocked: ReasonCodeSchema.nullable(),
});
export type PreviewItem = z.infer<typeof PreviewItemSchema>;
export const PreviewOutputSchema = z.object({
  items: z.array(PreviewItemSchema),
  deletable: z.number(),
  files: z.number(),
  bytes: z.number(),
});
export type PreviewOutput = z.infer<typeof PreviewOutputSchema>;

export const DeleteInputSchema = z.object({
  items: z
    .array(z.object({ key: z.string().min(1).max(600), fingerprint: z.string().regex(/^[0-9a-f]{64}$/) }))
    .min(1)
    .max(MAX_BATCH),
  /** The client sends this only from the confirmation dialog. */
  confirm: z.literal(true),
});
export const OperationResultSchema = z.object({
  id: z.string(),
  ok: z.boolean(),
  reason: ReasonCodeSchema.nullable(),
  trashId: z.string().nullable(),
});
export type OperationResult = z.infer<typeof OperationResultSchema>;
export const OperationOutputSchema = z.object({ results: z.array(OperationResultSchema) });
export type OperationOutput = z.infer<typeof OperationOutputSchema>;

export const TrashEntrySchema = z.object({
  trashId: z.string(),
  provider: ProviderSchema,
  sessionId: z.string(),
  title: z.string(),
  cwd: z.string(),
  rootPath: z.string(),
  projectDirectory: z.string(),
  deletedAt: z.string(),
  bytes: z.number(),
  files: z.number(),
  status: z.enum(["complete", "incomplete", "invalid"]),
});
export type TrashEntry = z.infer<typeof TrashEntrySchema>;
export const TrashListOutputSchema = z.object({ entries: z.array(TrashEntrySchema), bytes: z.number(), path: z.string() });
export type TrashListOutput = z.infer<typeof TrashListOutputSchema>;

const TrashIdSchema = z.string().regex(/^[0-9]{13}-[0-9a-f]{12}$/);
export const TRASH_ID = /^[0-9]{13}-[0-9a-f]{12}$/;
export const RestoreInputSchema = z.object({ trashIds: z.array(TrashIdSchema).min(1).max(MAX_BATCH) });
export const PurgeInputSchema = z.object({
  trashIds: z.array(TrashIdSchema).max(5000).default([]),
  all: z.boolean().default(false),
  confirm: z.literal(true),
});
