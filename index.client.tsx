import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { SESSION_MANAGER_ICON } from "./client/icons/brands";
import { messages } from "./client/messages";
import { SessionManagerScreen } from "./client/screen";

/**
 * Must NOT contain "sessions": Paseo's built-in History sidebar row checks
 * `pathname.includes("/sessions")`, so a screen ID of "sessions" causes both History and
 * SessionManager to highlight at the same time.
 */
const SCREEN = "manager";

function SidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return (
    <SidebarRow
      icon={SESSION_MANAGER_ICON}
      active={currentScreen?.screenId === SCREEN}
      onPress={() => openScreen({ screenId: SCREEN })}
    />
  );
}

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addScreen({ id: SCREEN, title: messages.message("app.title"), Component: SessionManagerScreen }),
    client.addSidebarHeaderItem({ id: "session-manager", title: messages.message("app.sidebar"), Component: SidebarItem }),
    client.addCommandCenterItem({
      id: "open-session-manager",
      title: messages.message("app.open"),
      icon: SESSION_MANAGER_ICON,
      context: "global",
      keywords: ["session", "sessions", "manager", "claude", "codex", "antigravity", "agy", "history", "resume", "trash", "会话", "历史", "回收站"],
      onSelect({ openScreen }) {
        openScreen({ screenId: SCREEN });
      },
    }),
  ];
  return async () => {
    for (const remove of removers) await remove();
  };
}
