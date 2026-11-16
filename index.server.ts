import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  deleteSessions,
  listSessions,
  listTrash,
  previewDelete,
  purgeTrash,
  restoreTrash,
  sessionDetail,
} from "./shared/contracts";
import { SessionManager } from "./server/service";

/**
 * Runs in the daemon subprocess of the host the plugin is installed on. Each host has its own
 * installation, its own manager, catalog, and trash; nothing is shared between hosts.
 */
export default function contribute(server: PluginServerContext) {
  const manager = new SessionManager();
  server.handle(listSessions, (input) => manager.list(input));
  server.handle(sessionDetail, ({ key }) => manager.detail(key));
  server.handle(previewDelete, ({ keys }) => manager.previewDelete(keys));
  server.handle(deleteSessions, ({ items }) => manager.deleteSessions(items));
  server.handle(listTrash, () => manager.listTrash());
  server.handle(restoreTrash, ({ trashIds }) => manager.restore(trashIds));
  server.handle(purgeTrash, ({ trashIds, all }) => manager.purge(trashIds, all));
  return () => manager.dispose();
}
