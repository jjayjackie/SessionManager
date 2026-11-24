import type { PluginTheme } from "@getpaseo/plugin";
import { useTranslation } from "@getpaseo/plugin/client";
import { copyText, Icon, useToast } from "@getpaseo/plugin/client/ui";
import { ActivityIndicator, Text, View } from "react-native";
import { formatBytes, resumeCommand } from "../shared/format";
import type { DetailOutput, FileKind } from "../shared/schema";
import { useSessionDetail } from "./data";
import { errorText, formatDateTime, reasonFromError } from "./format";
import { messages } from "./messages";
import { useSessionBadges } from "./session-list";
import { Badge, Banner, Button, Divider, Field, MetricCard, ProviderLogo, ProviderTag, SectionHeader, providerBrandColor } from "./ui";

interface Props {
  theme: PluginTheme;
  hostId: string;
  sessionKey: string | null;
  onDelete(key: string): void;
  onOpenSession(key: string): void;
  openAgent?: (agentId: string) => void;
}

const FOLDER_KINDS = new Set<FileKind>(["session-dir", "file-history", "session-env", "tasks", "brain-dir"]);

export function DetailPane({ theme, hostId, sessionKey, onDelete, onOpenSession, openAgent }: Props) {
  const { t } = useTranslation(messages);
  const query = useSessionDetail(hostId, sessionKey);
  const c = theme.colors;
  if (!sessionKey) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 28, gap: 10 }}>
        <View
          style={{
            width: 42,
            height: 42,
            borderRadius: 6,
            borderWidth: 1,
            borderColor: c.border,
            backgroundColor: c.surface1,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Icon name="PanelRight" size={20} color={c.foregroundMuted} />
        </View>
        <Text style={{ color: c.foregroundMuted, fontSize: 12.5, textAlign: "center" }}>{t("detail.placeholder")}</Text>
      </View>
    );
  }
  if (query.isPending) {
    return (
      <View accessibilityLabel={t("detail.loading")} style={{ padding: 28, alignItems: "center" }}>
        <ActivityIndicator color={c.foregroundMuted} />
      </View>
    );
  }
  if (query.isError || !query.data) {
    const reason = reasonFromError(query.error);
    return (
      <View style={{ padding: 16 }}>
        <Banner theme={theme} tone="danger" text={reason ? t(`reason.${reason}`) : t("status.error", { message: errorText(query.error) })} />
      </View>
    );
  }
  return <DetailBody theme={theme} detail={query.data} onDelete={onDelete} onOpenSession={onOpenSession} openAgent={openAgent} />;
}

function DetailBody({
  theme,
  detail,
  onDelete,
  onOpenSession,
  openAgent,
}: {
  theme: PluginTheme;
  detail: DetailOutput;
  onDelete(key: string): void;
  onOpenSession(key: string): void;
  openAgent?: (agentId: string) => void;
}) {
  const { t, locale } = useTranslation(messages);
  const toast = useToast();
  const badges = useSessionBadges()(detail.session);
  const c = theme.colors;
  const s = detail.session;
  const agent = s.paseo;
  const providerName = t(`provider.${s.provider}`);
  const command = resumeCommand({
    provider: s.provider,
    sessionId: s.sessionId,
    cwd: s.cwd,
    rootPath: detail.rootPath,
    isDefaultRoot: detail.isDefaultRoot,
  });

  async function copy(text: string) {
    try {
      await copyText(text);
      toast.show(t("detail.copied"), { variant: "success" });
    } catch {
      toast.error(t("detail.copyFailed"));
    }
  }

  return (
    <View style={{ padding: 16, gap: 14 }}>
      {/* Inspector Header */}
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <ProviderTag theme={theme} provider={s.provider} label={providerName} />
          {badges.map((badge) => (
            <Badge key={badge.key} theme={theme} label={badge.label} tone={badge.tone} icon={badge.icon} />
          ))}
        </View>
        <Text selectable style={{ color: c.foreground, fontSize: 15.5, fontWeight: "700", lineHeight: 21 }}>
          {s.title || t("list.untitled")}
        </Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, paddingTop: 2 }}>
          <Button theme={theme} compact icon="Copy" label={t("detail.copyId")} onPress={() => void copy(s.sessionId)} />
          {agent && !agent.archived && openAgent ? (
            <Button theme={theme} compact icon="ExternalLink" label={t("detail.openAgent")} onPress={() => openAgent(agent.agentId)} />
          ) : null}
          <Button theme={theme} compact icon="Trash2" variant="danger" label={t("detail.delete")} disabled={Boolean(detail.blocked)} onPress={() => onDelete(s.key)} />
        </View>
      </View>

      {detail.blocked ? <Banner theme={theme} tone="warning" text={t(`reason.${detail.blocked}`)} /> : null}
      {s.badLines ? <Banner theme={theme} tone="danger" text={t("detail.damaged", { count: s.badLines })} /> : null}

      {/* Terminal Resume Command */}
      <View style={{ gap: 6 }}>
        <SectionHeader theme={theme} title={t("detail.resume", { provider: providerName })} />
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            paddingHorizontal: 10,
            paddingVertical: 8,
            borderRadius: 5,
            borderWidth: 1,
            borderColor: c.border,
            backgroundColor: c.surface2,
          }}
        >
          <Icon name="Terminal" size={13} color={c.foregroundMuted} />
          <Text selectable style={{ flex: 1, color: c.foreground, fontSize: 11.5, fontFamily: "monospace" }}>
            {command}
          </Text>
          <Button theme={theme} compact iconOnly icon="Copy" label={t("detail.copy")} onPress={() => void copy(command)} />
        </View>
        {!s.cwd ? <Text style={{ color: c.foregroundMuted, fontSize: 11.5 }}>{t("detail.resumeUnavailable")}</Text> : null}
      </View>

      {/* Industrial 2x2 Metric Grid */}
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: "row", gap: 6 }}>
          <MetricCard theme={theme} label={t("detail.started")} value={formatDateTime(s.startedAt, locale)} />
          <MetricCard theme={theme} label={t("detail.updated")} value={formatDateTime(s.updatedAt, locale)} />
        </View>
        <View style={{ flexDirection: "row", gap: 6 }}>
          <MetricCard theme={theme} label={t("detail.messages")} value={t("detail.messagesValue", { user: s.userMessages, assistant: s.assistantMessages })} />
          <MetricCard theme={theme} label={t("detail.size")} value={formatBytes(s.bytes)} />
        </View>
      </View>

      {/* Technical Metadata Spec */}
      <View style={{ borderRadius: 5, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, padding: 10, gap: 10 }}>
        <Field theme={theme} label={t("detail.sessionId")} value={s.sessionId} mono />
        <Field theme={theme} label={t("detail.project")} value={s.cwd} mono />
        {s.gitBranch ? <Field theme={theme} label={t("detail.branch")} value={s.gitBranch} mono /> : null}
        {detail.version ? <Field theme={theme} label={t("detail.version", { provider: providerName })} value={detail.version} mono /> : null}
        {detail.models.length ? <Field theme={theme} label={t("detail.models")} value={detail.models.join(", ")} mono /> : null}
        <Field theme={theme} label={t("detail.configDir")} value={detail.rootPath} mono />
      </View>

      {/* Files Manifest */}
      <View style={{ gap: 6 }}>
        <SectionHeader theme={theme} title={t("detail.files")} right={String(detail.files.length)} />
        <View style={{ borderRadius: 5, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, overflow: "hidden" }}>
          {detail.files.map((file, index) => (
            <View
              key={file.path}
              style={{
                flexDirection: "row",
                gap: 8,
                alignItems: "center",
                paddingHorizontal: 10,
                paddingVertical: 7,
                borderBottomWidth: index === detail.files.length - 1 ? 0 : 1,
                borderBottomColor: c.border,
              }}
            >
              <Icon name={FOLDER_KINDS.has(file.kind) ? "Folder" : "File"} size={12} color={c.foregroundMuted} />
              <Text selectable numberOfLines={2} style={{ flex: 1, color: c.foreground, fontSize: 11.5, fontFamily: "monospace" }}>
                {file.path}
              </Text>
              <Text style={{ color: c.foregroundMuted, fontSize: 11, fontFamily: "monospace", fontVariant: ["tabular-nums"] }}>{formatBytes(file.bytes)}</Text>
            </View>
          ))}
        </View>
        {detail.keptShared.length ? (
          <View style={{ gap: 4, paddingTop: 2 }}>
            <Text style={{ color: c.statusWarning, fontSize: 11.5 }}>{t("detail.keptShared")}</Text>
            {detail.keptShared.map((file) => (
              <Text key={file.path} selectable style={{ color: c.foregroundMuted, fontSize: 11.5, fontFamily: "monospace" }}>
                {file.path}
              </Text>
            ))}
          </View>
        ) : null}
      </View>

      {detail.duplicates.length || detail.related.length || detail.duplicateUuids ? (
        <>
          <Divider theme={theme} />
          <View style={{ gap: 8 }}>
            {detail.duplicates.length ? (
              <View style={{ gap: 4 }}>
                <SectionHeader theme={theme} title={t("detail.duplicates")} right={String(detail.duplicates.length)} />
                {detail.duplicates.map((key) => (
                  <Text key={key} selectable style={{ color: c.foreground, fontSize: 11.5, fontFamily: "monospace" }}>
                    {key}
                  </Text>
                ))}
              </View>
            ) : null}
            {detail.related.length ? (
              <View style={{ gap: 4 }}>
                <SectionHeader theme={theme} title={t("detail.related")} right={String(detail.related.length)} />
                {detail.related.map((item) => (
                  <Button
                    key={item.key}
                    theme={theme}
                    compact
                    variant="ghost"
                    icon="GitFork"
                    label={`${item.title || t("list.untitled")} · ${t("detail.shared", { count: item.shared })}`}
                    onPress={() => onOpenSession(item.key)}
                    style={{ justifyContent: "flex-start" }}
                  />
                ))}
              </View>
            ) : null}
            {detail.duplicateUuids ? <Text style={{ color: c.foregroundMuted, fontSize: 11.5 }}>{t("detail.duplicateUuids", { count: detail.duplicateUuids })}</Text> : null}
          </View>
        </>
      ) : null}

      {/* Conversation Preview */}
      <Divider theme={theme} />
      <View style={{ gap: 8 }}>
        <SectionHeader theme={theme} title={t("detail.preview")} right={detail.preview.length ? String(detail.preview.length) : undefined} />
        {detail.preview.length ? (
          detail.preview.map((message, index) => (
            <View
              key={`${index}-${message.timestamp ?? ""}`}
              style={{
                gap: 4,
                paddingHorizontal: 10,
                paddingVertical: 8,
                borderRadius: 5,
                backgroundColor: message.role === "user" ? c.surface2 : c.surface1,
                borderWidth: 1,
                borderColor: c.border,
                borderLeftWidth: 2.5,
                borderLeftColor: message.role === "user" ? c.accent : providerBrandColor(s.provider),
              }}
            >
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
                  {message.role === "assistant" ? <ProviderLogo provider={s.provider} size={11} /> : null}
                  <Text style={{ color: message.role === "user" ? c.accent : c.foregroundMuted, fontSize: 10, fontWeight: "700", letterSpacing: 0.5, textTransform: "uppercase" }}>
                    {message.role === "user" ? t("detail.you") : providerName}
                  </Text>
                </View>
                {message.timestamp ? (
                  <Text style={{ color: c.foregroundMuted, fontSize: 10.5, fontFamily: "monospace" }}>{formatDateTime(message.timestamp, locale)}</Text>
                ) : null}
              </View>
              <Text selectable style={{ color: c.foreground, fontSize: 12, lineHeight: 17 }}>
                {message.text}
              </Text>
            </View>
          ))
        ) : (
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{t("detail.noPreview")}</Text>
        )}
      </View>
    </View>
  );
}
