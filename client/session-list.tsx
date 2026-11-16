import type { PluginTheme } from "@getpaseo/plugin";
import { useTranslation } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { memo } from "react";
import { Pressable, Text, View } from "react-native";
import { formatBytes } from "../shared/format";
import type { SessionSummary } from "../shared/schema";
import { formatAge } from "./format";
import { messages } from "./messages";
import { Badge, Button, Checkbox } from "./ui";

export function useSessionBadges() {
  const { t } = useTranslation(messages);
  return (session: SessionSummary) => {
    const badges: { key: string; label: string; tone: "accent" | "success" | "warning" | "danger" | "neutral"; icon?: string }[] = [];
    if (session.state === "running") badges.push({ key: "running", label: t("badge.running"), tone: "success", icon: "Activity" });
    else if (session.state === "recent") badges.push({ key: "recent", label: t("badge.recent"), tone: "warning", icon: "Activity" });
    if (session.health === "damaged") badges.push({ key: "damaged", label: t("badge.damaged"), tone: "danger", icon: "TriangleAlert" });
    if (session.health === "empty") badges.push({ key: "empty", label: t("badge.empty"), tone: "neutral" });
    if (session.duplicateId) badges.push({ key: "duplicate", label: t("badge.duplicate"), tone: "warning", icon: "Copy" });
    if (session.paseo) badges.push({ key: "paseo", label: session.paseo.archived ? t("badge.archived") : t("badge.paseo"), tone: "accent" });
    return badges;
  };
}

interface RowProps {
  theme: PluginTheme;
  session: SessionSummary;
  selected: boolean;
  active: boolean;
  compact: boolean;
  showProject: boolean;
  onToggle(key: string): void;
  onOpen(key: string): void;
}

const SessionRow = memo(function SessionRow({ theme, session, selected, active, compact, showProject, onToggle, onOpen }: RowProps) {
  const { t, locale } = useTranslation(messages);
  const badges = useSessionBadges()(session);
  const c = theme.colors;
  const title = session.title || t("list.untitled");
  const messagesCount = session.userMessages + session.assistantMessages;
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        paddingHorizontal: compact ? 10 : 14,
        paddingVertical: 10,
        borderBottomWidth: 1,
        borderBottomColor: c.border,
        backgroundColor: active ? c.surface2 : selected ? c.surface1 : "transparent",
        borderLeftWidth: 3,
        borderLeftColor: active ? c.accent : "transparent",
      }}
    >
      <View style={{ paddingTop: 2 }}>
        <Checkbox theme={theme} checked={selected} label={t("list.select", { title })} onToggle={() => onToggle(session.key)} />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ selected: active }}
        onPress={() => onOpen(session.key)}
        style={({ pressed }) => ({ flex: 1, gap: 4, opacity: pressed ? 0.75 : 1 })}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Text numberOfLines={1} style={{ flex: 1, color: c.foreground, fontSize: 14, fontWeight: "600" }}>
            {title}
          </Text>
          <Text style={{ color: c.foregroundMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}>{formatAge(session.updatedAt, locale)}</Text>
        </View>
        {session.snippet ? (
          <Text numberOfLines={2} style={{ color: c.foregroundMuted, fontSize: 12, fontStyle: "italic" }}>
            {session.snippet}
          </Text>
        ) : session.firstPrompt && session.firstPrompt !== session.title ? (
          <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12 }}>
            {session.firstPrompt}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
          {showProject && session.cwd ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, maxWidth: "100%" }}>
              <Icon name="Folder" size={12} color={c.foregroundMuted} />
              <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12, flexShrink: 1 }}>
                {session.cwd}
              </Text>
            </View>
          ) : null}
          {session.gitBranch ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
              <Icon name="GitBranch" size={12} color={c.foregroundMuted} />
              <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12, maxWidth: 160 }}>
                {session.gitBranch}
              </Text>
            </View>
          ) : null}
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{t("list.messages", { count: messagesCount })}</Text>
          {session.subagentCount ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{t("list.subagents", { count: session.subagentCount })}</Text> : null}
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{formatBytes(session.bytes)}</Text>
          {badges.map((badge) => (
            <Badge key={badge.key} theme={theme} label={badge.label} tone={badge.tone} icon={badge.icon} />
          ))}
        </View>
      </Pressable>
    </View>
  );
});

interface ListProps {
  theme: PluginTheme;
  compact: boolean;
  items: SessionSummary[];
  total: number;
  page: number;
  pageSize: number;
  selected: ReadonlySet<string>;
  activeKey: string | null;
  showProject: boolean;
  emptyHost: boolean;
  onToggle(key: string): void;
  onTogglePage(): void;
  onClearSelection(): void;
  onDeleteSelected(): void;
  onOpen(key: string): void;
  onPage(page: number): void;
}

export function SessionList(props: ListProps) {
  const { theme, compact, items, total, page, pageSize, selected, activeKey, showProject } = props;
  const { t } = useTranslation(messages);
  const c = theme.colors;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const onPage = items.filter((item) => selected.has(item.key)).length;
  const allOnPage = items.length > 0 && onPage === items.length;
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 10,
          paddingHorizontal: compact ? 10 : 14,
          paddingVertical: 8,
          borderBottomWidth: 1,
          borderBottomColor: c.border,
          backgroundColor: c.surface1,
          flexWrap: "wrap",
        }}
      >
        <Checkbox theme={theme} checked={allOnPage} mixed={onPage > 0 && !allOnPage} label={t("list.selectPage")} onToggle={props.onTogglePage} disabled={!items.length} />
        <Text style={{ color: c.foregroundMuted, fontSize: 12, flex: 1 }}>
          {selected.size ? t("list.selected", { count: selected.size }) : t("list.selectPage")}
        </Text>
        {selected.size ? (
          <>
            <Button theme={theme} compact label={t("list.clear")} variant="ghost" onPress={props.onClearSelection} />
            <Button theme={theme} compact label={t("list.deleteSelected")} icon="Trash2" variant="danger" onPress={props.onDeleteSelected} />
          </>
        ) : null}
      </View>
      {items.length ? (
        items.map((session) => (
          <SessionRow
            key={session.key}
            theme={theme}
            session={session}
            selected={selected.has(session.key)}
            active={session.key === activeKey}
            compact={compact}
            showProject={showProject}
            onToggle={props.onToggle}
            onOpen={props.onOpen}
          />
        ))
      ) : (
        <View style={{ alignItems: "center", justifyContent: "center", padding: 40, gap: 10 }}>
          <Icon name="Inbox" size={28} color={c.foregroundMuted} />
          <Text style={{ color: c.foregroundMuted, fontSize: 13, textAlign: "center" }}>{props.emptyHost ? t("list.emptyHost") : t("list.empty")}</Text>
        </View>
      )}
      {pages > 1 ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 12, padding: 12 }}>
          <Button theme={theme} compact iconOnly icon="ChevronLeft" label={t("list.previous")} disabled={page <= 0} onPress={() => props.onPage(page - 1)} />
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{t("list.page", { page: page + 1, pages })}</Text>
          <Button theme={theme} compact iconOnly icon="ChevronRight" label={t("list.next")} disabled={page >= pages - 1} onPress={() => props.onPage(page + 1)} />
        </View>
      ) : null}
    </View>
  );
}
