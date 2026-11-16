import type { PluginTheme } from "@getpaseo/plugin";
import { useTranslation } from "@getpaseo/plugin/client";
import { copyText, Icon, useToast } from "@getpaseo/plugin/client/ui";
import { ActivityIndicator, Text, View } from "react-native";
import { formatBytes, resumeCommand } from "../shared/format";
import type { DetailOutput } from "../shared/schema";
import { useSessionDetail } from "./data";
import { errorText, formatDateTime, reasonFromError } from "./format";
import { messages } from "./messages";
import { useSessionBadges } from "./session-list";
import { Badge, Banner, Button, Divider, Field } from "./ui";

interface Props {
  theme: PluginTheme;
  hostId: string;
  sessionKey: string | null;
  onDelete(key: string): void;
  onOpenSession(key: string): void;
  openAgent?: (agentId: string) => void;
}

export function DetailPane({ theme, hostId, sessionKey, onDelete, onOpenSession, openAgent }: Props) {
  const { t } = useTranslation(messages);
  const query = useSessionDetail(hostId, sessionKey);
  const c = theme.colors;
  if (!sessionKey) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 10 }}>
        <Icon name="PanelRight" size={28} color={c.foregroundMuted} />
        <Text style={{ color: c.foregroundMuted, fontSize: 13, textAlign: "center" }}>{t("detail.placeholder")}</Text>
      </View>
    );
  }
  if (query.isPending) {
    return (
      <View accessibilityLabel={t("detail.loading")} style={{ padding: 24, alignItems: "center" }}>
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

function DetailBody({ theme, detail, onDelete, onOpenSession, openAgent }: { theme: PluginTheme; detail: DetailOutput; onDelete(key: string): void; onOpenSession(key: string): void; openAgent?: (agentId: string) => void }) {
  const { t, locale } = useTranslation(messages);
  const toast = useToast();
  const badges = useSessionBadges()(detail.session);
  const c = theme.colors;
  const s = detail.session;
  const agent = s.paseo;
  const command = resumeCommand({ sessionId: s.sessionId, cwd: s.cwd, rootPath: detail.rootPath, isDefaultRoot: detail.isDefaultRoot });

  async function copy(text: string) {
    try {
      await copyText(text);
      toast.show(t("detail.copied"), { variant: "success" });
    } catch {
      toast.error(t("detail.copyFailed"));
    }
  }

  const section = (title: string) => <Text style={{ color: c.foregroundMuted, fontSize: 11, fontWeight: "700", letterSpacing: 0.4, textTransform: "uppercase" }}>{title}</Text>;

  return (
    <View style={{ padding: 16, gap: 14 }}>
      <View style={{ gap: 6 }}>
        <Text selectable style={{ color: c.foreground, fontSize: 16, fontWeight: "700" }}>
          {s.title || t("list.untitled")}
        </Text>
        {badges.length ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {badges.map((badge) => (
              <Badge key={badge.key} theme={theme} label={badge.label} tone={badge.tone} icon={badge.icon} />
            ))}
          </View>
        ) : null}
      </View>

      {detail.blocked ? <Banner theme={theme} tone="warning" text={t(`reason.${detail.blocked}`)} /> : null}
      {s.badLines ? <Banner theme={theme} tone="danger" text={t("detail.damaged", { count: s.badLines })} /> : null}

      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button theme={theme} compact icon="Copy" label={t("detail.copyId")} onPress={() => void copy(s.sessionId)} />
        {agent && !agent.archived && openAgent ? (
          <Button theme={theme} compact icon="ExternalLink" label={t("detail.openAgent")} onPress={() => openAgent(agent.agentId)} />
        ) : null}
        <Button theme={theme} compact icon="Trash2" variant="danger" label={t("detail.delete")} disabled={Boolean(detail.blocked)} onPress={() => onDelete(s.key)} />
      </View>

      <View style={{ gap: 6 }}>
        {section(t("detail.resume"))}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface2 }}>
          <Text selectable style={{ flex: 1, color: c.foreground, fontSize: 12, fontFamily: "monospace" }}>
            {command}
          </Text>
          <Button theme={theme} compact iconOnly icon="Copy" label={t("detail.copy")} onPress={() => void copy(command)} />
        </View>
        {!s.cwd ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{t("detail.resumeUnavailable")}</Text> : null}
      </View>

      <Divider theme={theme} />
      <View style={{ gap: 12 }}>
        <Field theme={theme} label={t("detail.sessionId")} value={s.sessionId} mono />
        <Field theme={theme} label={t("detail.project")} value={s.cwd} mono />
        {s.gitBranch ? <Field theme={theme} label={t("detail.branch")} value={s.gitBranch} /> : null}
        <View style={{ flexDirection: "row", gap: 16, flexWrap: "wrap" }}>
          <Field theme={theme} label={t("detail.started")} value={formatDateTime(s.startedAt, locale)} />
          <Field theme={theme} label={t("detail.updated")} value={formatDateTime(s.updatedAt, locale)} />
        </View>
        <View style={{ flexDirection: "row", gap: 16, flexWrap: "wrap" }}>
          <Field theme={theme} label={t("detail.messages")} value={t("detail.messagesValue", { user: s.userMessages, assistant: s.assistantMessages })} />
          <Field theme={theme} label={t("detail.size")} value={formatBytes(s.bytes)} />
        </View>
        {detail.version ? <Field theme={theme} label={t("detail.version")} value={detail.version} /> : null}
        {detail.models.length ? <Field theme={theme} label={t("detail.models")} value={detail.models.join(", ")} /> : null}
        <Field theme={theme} label={t("detail.configDir")} value={detail.rootPath} mono />
      </View>

      <Divider theme={theme} />
      <View style={{ gap: 6 }}>
        {section(t("detail.files"))}
        {detail.files.map((file) => (
          <View key={file.path} style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
            <Icon name={file.kind === "session-dir" || file.kind === "file-history" || file.kind === "session-env" || file.kind === "tasks" ? "Folder" : "File"} size={13} color={c.foregroundMuted} />
            <Text selectable numberOfLines={2} style={{ flex: 1, color: c.foreground, fontSize: 12, fontFamily: "monospace" }}>
              {file.path}
            </Text>
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{formatBytes(file.bytes)}</Text>
          </View>
        ))}
        {detail.keptShared.length ? (
          <View style={{ gap: 4, marginTop: 4 }}>
            <Text style={{ color: c.statusWarning, fontSize: 12 }}>{t("detail.keptShared")}</Text>
            {detail.keptShared.map((file) => (
              <Text key={file.path} selectable style={{ color: c.foregroundMuted, fontSize: 12, fontFamily: "monospace" }}>
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
                {section(t("detail.duplicates"))}
                {detail.duplicates.map((key) => (
                  <Text key={key} selectable style={{ color: c.foreground, fontSize: 12, fontFamily: "monospace" }}>
                    {key}
                  </Text>
                ))}
              </View>
            ) : null}
            {detail.related.length ? (
              <View style={{ gap: 4 }}>
                {section(t("detail.related"))}
                {detail.related.map((item) => (
                  <Button key={item.key} theme={theme} compact variant="ghost" icon="GitFork" label={`${item.title || t("list.untitled")} · ${t("detail.shared", { count: item.shared })}`} onPress={() => onOpenSession(item.key)} style={{ justifyContent: "flex-start" }} />
                ))}
              </View>
            ) : null}
            {detail.duplicateUuids ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{t("detail.duplicateUuids", { count: detail.duplicateUuids })}</Text> : null}
          </View>
        </>
      ) : null}

      <Divider theme={theme} />
      <View style={{ gap: 8 }}>
        {section(t("detail.preview"))}
        {detail.preview.length ? (
          detail.preview.map((message, index) => (
            <View key={`${index}-${message.timestamp ?? ""}`} style={{ gap: 3, padding: 10, borderRadius: 8, backgroundColor: message.role === "user" ? c.surface2 : c.surface1, borderWidth: 1, borderColor: c.border }}>
              <Text style={{ color: message.role === "user" ? c.accent : c.foregroundMuted, fontSize: 11, fontWeight: "700" }}>
                {message.role === "user" ? t("detail.you") : t("detail.claude")}
                {message.timestamp ? ` · ${formatDateTime(message.timestamp, locale)}` : ""}
              </Text>
              <Text selectable style={{ color: c.foreground, fontSize: 12 }}>
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
