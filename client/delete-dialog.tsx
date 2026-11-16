import type { PluginTheme } from "@getpaseo/plugin";
import { useTranslation } from "@getpaseo/plugin/client";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/ui";
import { ActivityIndicator, Text, View } from "react-native";
import { formatBytes } from "../shared/format";
import type { OperationOutput } from "../shared/schema";
import { useDeletePreview, useDeleteSessions } from "./data";
import { errorText } from "./format";
import { messages } from "./messages";
import { Banner, Button } from "./ui";

interface Props {
  theme: PluginTheme;
  hostId: string;
  keys: string[] | null;
  onClose(): void;
  onDeleted(result: OperationOutput): void;
}

/**
 * Two-step deletion: the host computes exactly which files each session owns and whether it is in
 * use; confirming sends back the preview's fingerprints, so the host refuses any session that
 * changed in between.
 */
export function DeleteDialog({ theme, hostId, keys, onClose, onDeleted }: Props) {
  const { t } = useTranslation(messages);
  const toast = useToast();
  const preview = useDeletePreview(hostId, keys);
  const remove = useDeleteSessions(hostId);
  const c = theme.colors;
  const data = preview.data;
  const deletable = data?.items.filter((item) => !item.blocked) ?? [];
  const blocked = data?.items.filter((item) => item.blocked) ?? [];

  async function confirm() {
    try {
      const result = await remove.mutateAsync(deletable.map((item) => ({ key: item.key, fingerprint: item.fingerprint })));
      const ok = result.results.filter((item) => item.ok).length;
      const failed = result.results.length - ok;
      if (!ok) toast.error(t("delete.failed"));
      else if (failed) toast.show(t("delete.partial", { ok, failed }), { variant: "warning" });
      else toast.show(t("delete.done", { count: ok }), { variant: "success" });
      onDeleted(result);
    } catch (error) {
      toast.error(errorText(error));
    }
  }

  return (
    <Modal
      title={t("delete.title")}
      icon={<Icon name="Trash2" size={18} color={c.statusDanger} />}
      open={Boolean(keys)}
      onOpenChange={(open) => {
        if (!open && !remove.isPending) onClose();
      }}
    >
      <Modal.Content>
        {preview.isPending ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <ActivityIndicator color={c.foregroundMuted} />
            <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>{t("delete.checking")}</Text>
          </View>
        ) : preview.isError || !data ? (
          <Banner theme={theme} tone="danger" text={t("status.error", { message: errorText(preview.error) })} />
        ) : (
          <View style={{ gap: 14 }}>
            {deletable.length ? (
              <Text style={{ color: c.foreground, fontSize: 14 }}>{t("delete.summary", { count: data.deletable, files: data.files, size: formatBytes(data.bytes) })}</Text>
            ) : (
              <Banner theme={theme} tone="warning" text={t("delete.nothing")} />
            )}
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{t("delete.note")}</Text>
            {deletable.length && deletable.length <= 8 ? (
              <View style={{ gap: 4 }}>
                {deletable.map((item) => (
                  <View key={item.key} style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
                    <Icon name="MessageSquare" size={13} color={c.foregroundMuted} />
                    <Text numberOfLines={1} style={{ flex: 1, color: c.foreground, fontSize: 12 }}>
                      {item.title || t("list.untitled")}
                    </Text>
                    <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{formatBytes(item.bytes)}</Text>
                  </View>
                ))}
              </View>
            ) : null}
            {blocked.length ? (
              <View style={{ gap: 6 }}>
                <Text style={{ color: c.statusWarning, fontSize: 12, fontWeight: "700" }}>
                  {t("delete.skipped")} ({blocked.length})
                </Text>
                {blocked.slice(0, 20).map((item) => (
                  <View key={item.key} style={{ gap: 1 }}>
                    <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 12 }}>
                      {item.title || item.key}
                    </Text>
                    {item.blocked ? <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{t(`reason.${item.blocked}`)}</Text> : null}
                  </View>
                ))}
              </View>
            ) : null}
          </View>
        )}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 10, flexWrap: "wrap" }}>
          <Button theme={theme} label={t("delete.cancel")} onPress={onClose} disabled={remove.isPending} />
          <Button
            theme={theme}
            variant="danger"
            icon="Trash2"
            label={t("delete.confirm", { count: deletable.length })}
            disabled={!deletable.length || preview.isPending}
            busy={remove.isPending}
            onPress={() => void confirm()}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}
