import type { PluginClientContext, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { messages } from "./client/messages";
import { SessionManagerScreen } from "./client/screen";

const SCREEN = "sessions";

function SidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="History" active={currentScreen?.screenId === SCREEN} onPress={() => openScreen({ screenId: SCREEN })} />;
}

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addScreen({ id: SCREEN, title: messages.message("app.title"), Component: SessionManagerScreen }),
    client.addSidebarHeaderItem({ id: "claude-sessions", title: messages.message("app.sidebar"), Component: SidebarItem }),
    client.addCommandCenterItem({
      id: "open-claude-sessions",
      title: messages.message("app.open"),
      icon: "History",
      context: "global",
      keywords: ["claude", "session", "sessions", "history", "resume", "trash", "会话", "历史", "回收站"],
      onSelect({ openScreen }) {
        openScreen({ screenId: SCREEN });
      },
    }),
  ];
  return async () => {
    for (const remove of removers) await remove();
  };
}
