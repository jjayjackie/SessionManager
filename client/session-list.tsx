import type { PluginTheme } from "@getpaseo/plugin";
import { useTranslation } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { memo, useMemo } from "react";
import { Pressable, Text, View } from "react-native";
import { formatBytes } from "../shared/format";
import type { SessionSummary } from "../shared/schema";
import { formatAge } from "./format";
import { messages } from "./messages";
import { Badge, Button, Checkbox, ProviderTag, providerBrandColor, type Tone } from "./ui";

export interface SessionBadge {
  key: string;
  label: string;
  tone: Tone;
  icon?: string;
}

export function buildSessionBadges(session: SessionSummary, t: (key: string) => string): SessionBadge[] {
  const badges: SessionBadge[] = [];
  if (session.state === "running") badges.push({ key: "running", label: t("badge.running"), tone: "success", icon: "Activity" });
  else if (session.state === "recent") badges.push({ key: "recent", label: t("badge.recent"), tone: "warning", icon: "Activity" });
  if (session.health === "damaged") badges.push({ key: "damaged", label: t("badge.damaged"), tone: "danger", icon: "TriangleAlert" });
  if (session.health === "empty") badges.push({ key: "empty", label: t("badge.empty"), tone: "neutral" });
  if (session.duplicateId) badges.push({ key: "duplicate", label: t("badge.duplicate"), tone: "warning", icon: "Copy" });
  if (session.paseo) badges.push({ key: "paseo", label: session.paseo.archived ? t("badge.archived") : t("badge.paseo"), tone: "accent" });
  return badges;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
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
  const badges = useMemo(() => buildSessionBadges(session, (key) => t(key as never)), [session, t]);
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
        paddingVertical: 11,
        borderBottomWidth: 1,
        borderBottomColor: c.border,
        backgroundColor: active ? c.surface2 : selected ? c.surface1 : "transparent",
        borderLeftWidth: 2.5,
        borderLeftColor: active ? providerBrandColor(session.provider) : selected ? c.border : "transparent",
      }}
    >
      <View style={{ paddingTop: 3 }}>
        <Checkbox theme={theme} checked={selected} label={t("list.select", { title })} onToggle={() => onToggle(session.key)} />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ selected: active }}
        onPress={() => onOpen(session.key)}
        style={({ pressed }) => ({ flex: 1, gap: 5, opacity: pressed ? 0.78 : 1 })}
      >
        {/* Row 1: Provider brand emblem + Title + Relative age */}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <ProviderTag theme={theme} provider={session.provider} />
          <Text numberOfLines={1} style={{ flex: 1, color: c.foreground, fontSize: 13.5, fontWeight: "600" }}>
            {title}
          </Text>
          <Text style={{ color: c.foregroundMuted, fontSize: 11.5, fontFamily: "monospace", fontVariant: ["tabular-nums"] }}>
            {formatAge(session.updatedAt, locale)}
          </Text>
        </View>

        {/* Row 2: Search snippet or first prompt */}
        {session.snippet ? (
          <View style={{ borderLeftWidth: 2, borderLeftColor: c.accent, paddingLeft: 8 }}>
            <Text numberOfLines={2} style={{ color: c.foregroundMuted, fontSize: 12 }}>
              {session.snippet}
            </Text>
          </View>
        ) : session.firstPrompt && session.firstPrompt !== session.title ? (
          <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 12 }}>
            {session.firstPrompt}
          </Text>
        ) : null}

        {/* Row 3: Structured technical metadata + status badges */}
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          {showProject && session.cwd ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4, maxWidth: compact ? 160 : 220 }}>
              <Icon name="Folder" size={11} color={c.foregroundMuted} />
              <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 11.5, fontFamily: "monospace", flexShrink: 1 }}>
                {baseName(session.cwd)}
              </Text>
            </View>
          ) : null}
          {session.gitBranch ? (
            <View style={{ flexDirection: "row", alignItems: "center", gap: 3, maxWidth: 140 }}>
              <Icon name="GitBranch" size={11} color={c.foregroundMuted} />
              <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 11.5, fontFamily: "monospace", flexShrink: 1 }}>
                {session.gitBranch}
              </Text>
            </View>
          ) : null}
          <Text style={{ color: c.foregroundMuted, fontSize: 11.5, fontVariant: ["tabular-nums"] }}>{t("list.messages", { count: messagesCount })}</Text>
          {session.subagentCount ? (
            <Text style={{ color: c.foregroundMuted, fontSize: 11.5, fontVariant: ["tabular-nums"] }}>{t("list.subagents", { count: session.subagentCount })}</Text>
          ) : null}
          <Text style={{ color: c.foregroundMuted, fontSize: 11.5, fontFamily: "monospace", fontVariant: ["tabular-nums"] }}>{formatBytes(session.bytes)}</Text>
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

export const SessionList = memo(function SessionList(props: ListProps) {
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
          paddingVertical: 7,
          borderBottomWidth: 1,
          borderBottomColor: c.border,
          backgroundColor: c.surface1,
          flexWrap: "wrap",
        }}
      >
        <Checkbox theme={theme} checked={allOnPage} mixed={onPage > 0 && !allOnPage} label={t("list.selectPage")} onToggle={props.onTogglePage} disabled={!items.length} />
        <Text style={{ color: c.foregroundMuted, fontSize: 11.5, fontWeight: "600", flex: 1, fontVariant: ["tabular-nums"] }}>
          {selected.size ? t("list.selected", { count: selected.size }) : t("list.showing", { shown: items.length, total })}
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
        <View style={{ alignItems: "center", justifyContent: "center", padding: 44, gap: 10 }}>
          <Icon name="Inbox" size={26} color={c.foregroundMuted} />
          <Text style={{ color: c.foregroundMuted, fontSize: 13, textAlign: "center" }}>{props.emptyHost ? t("list.emptyHost") : t("list.empty")}</Text>
        </View>
      )}
      {pages > 1 ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 12, padding: 12, borderTopWidth: 1, borderTopColor: c.border }}>
          <Button theme={theme} compact iconOnly icon="ChevronLeft" label={t("list.previous")} disabled={page <= 0} onPress={() => props.onPage(page - 1)} />
          <Text style={{ color: c.foregroundMuted, fontSize: 11.5, fontFamily: "monospace", fontVariant: ["tabular-nums"] }}>
            {t("list.page", { page: page + 1, pages })}
          </Text>
          <Button theme={theme} compact iconOnly icon="ChevronRight" label={t("list.next")} disabled={page >= pages - 1} onPress={() => props.onPage(page + 1)} />
        </View>
      ) : null}
    </View>
  );
});
