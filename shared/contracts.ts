import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  DeleteInputSchema,
  DetailOutputSchema,
  ListInputSchema,
  ListOutputSchema,
  OperationOutputSchema,
  PreviewInputSchema,
  PreviewOutputSchema,
  PurgeInputSchema,
  RestoreInputSchema,
  TrashListOutputSchema,
} from "./schema";

/**
 * Plugin RPCs. Paseo routes each call to the daemon of the host selected in the screen header,
 * so every scan, read, delete, and restore runs on that host. Plugin RPC has no cross-host form.
 */
export const listSessions = defineRpc({ name: "sm.sessions.list", input: ListInputSchema, output: ListOutputSchema });

export const sessionDetail = defineRpc({
  name: "sm.sessions.detail",
  input: z.object({ key: z.string().min(1).max(600) }),
  output: DetailOutputSchema,
});

export const previewDelete = defineRpc({ name: "sm.sessions.preview-delete", input: PreviewInputSchema, output: PreviewOutputSchema });

export const deleteSessions = defineRpc({ name: "sm.sessions.delete", input: DeleteInputSchema, output: OperationOutputSchema });

export const listTrash = defineRpc({ name: "sm.trash.list", input: z.object({}), output: TrashListOutputSchema });

export const restoreTrash = defineRpc({ name: "sm.trash.restore", input: RestoreInputSchema, output: OperationOutputSchema });

export const purgeTrash = defineRpc({ name: "sm.trash.purge", input: PurgeInputSchema, output: OperationOutputSchema });
