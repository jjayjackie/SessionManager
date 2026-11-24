import type { PluginTheme } from "@getpaseo/plugin";
import { useTranslation } from "@getpaseo/plugin/client";
import { Icon, Modal, useToast } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { ActivityIndicator, Text, View } from "react-native";
import { formatBytes } from "../shared/format";
import type { OperationOutput, TrashEntry } from "../shared/schema";
import { usePurge, useRestore, useTrash } from "./data";
import { errorText, formatDateTime } from "./format";
import { messages } from "./messages";
import { Badge, Banner, Button, Checkbox, ProviderTag } from "./ui";

interface Props {
  theme: PluginTheme;
  hostId: string;
  compact: boolean;
}

export function TrashView({ theme, hostId, compact }: Props) {
  const { t, locale } = useTranslation(messages);
  const toast = useToast();
  const trash = useTrash(hostId, true);
  const restore = useRestore(hostId);
  const purge = usePurge(hostId);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [purgeTarget, setPurgeTarget] = useState<{ ids: string[]; all: boolean } | null>(null);
  const c = theme.colors;
  const entries = trash.data?.entries ?? [];
  const busy = restore.isPending || purge.isPending;

  function prune(result: OperationOutput) {
    const done = new Set(result.results.filter((item) => item.ok).map((item) => item.id));
    setSelected((current) => new Set([...current].filter((id) => !done.has(id))));
  }

  async function runRestore(ids: string[]) {
    try {
      const result = await restore.mutateAsync(ids);
      const ok = result.results.filter((item) => item.ok).length;
      const failed = result.results.length - ok;
      if (failed) {
        const reason = result.results.find((item) => !item.ok)?.reason;
        toast.show(`${t("trash.restorePartial", { ok, failed })}${reason ? ` ${t(`reason.${reason}`)}` : ""}`, { variant: "warning", durationMs: 5000 });
      } else toast.show(t("trash.restored", { count: ok }), { variant: "success" });
      prune(result);
    } catch (error) {
      toast.error(errorText(error));
    }
  }

  async function runPurge() {
    if (!purgeTarget) return;
    try {
      const result = await purge.mutateAsync({ trashIds: purgeTarget.ids, all: purgeTarget.all });
      const ok = result.results.filter((item) => item.ok).length;
      toast.show(t("trash.purged", { count: ok }), { variant: ok ? "success" : "warning" });
      prune(result);
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setPurgeTarget(null);
    }
  }

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const allSelected = entries.length > 0 && entries.every((entry) => selected.has(entry.trashId));
  const purgeEntries = purgeTarget ? (purgeTarget.all ? entries : entries.filter((entry) => purgeTarget.ids.includes(entry.trashId))) : [];
  const purgeBytes = purgeEntries.reduce((sum, entry) => sum + entry.bytes, 0);

  if (trash.isPending) {
    return (
      <View style={{ padding: 28, alignItems: "center" }}>
        <ActivityIndicator color={c.foregroundMuted} />
      </View>
    );
  }

  return (
    <View style={{ gap: 12, padding: compact ? 12 : 16 }}>
      {trash.isError ? <Banner theme={theme} tone="danger" text={t("status.error", { message: errorText(trash.error) })} /> : null}
      {trash.data ? (
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8, paddingHorizontal: 10, paddingVertical: 8, borderRadius: 5, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
          <Text selectable style={{ color: c.foregroundMuted, fontSize: 11.5, fontFamily: "monospace", flex: 1 }}>
            {t("trash.location", { path: trash.data.path })}
          </Text>
          <Text style={{ color: c.foreground, fontSize: 11.5, fontFamily: "monospace", fontWeight: "700", fontVariant: ["tabular-nums"] }}>
            {formatBytes(trash.data.bytes)}
          </Text>
        </View>
      ) : null}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap", paddingHorizontal: 10, paddingVertical: 8, borderRadius: 5, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
        <Checkbox
          theme={theme}
          checked={allSelected}
          mixed={selected.size > 0 && !allSelected}
          label={t("trash.selectAll")}
          disabled={!entries.length}
          onToggle={() => setSelected(allSelected ? new Set() : new Set(entries.map((entry) => entry.trashId)))}
        />
        <Text style={{ color: c.foregroundMuted, fontSize: 12, fontWeight: "600", flex: 1 }}>{selected.size ? t("list.selected", { count: selected.size }) : t("trash.selectAll")}</Text>
        <Button theme={theme} compact icon="RotateCcw" label={t("trash.restoreSelected")} disabled={!selected.size || busy} busy={restore.isPending} onPress={() => void runRestore([...selected])} />
        <Button theme={theme} compact icon="Trash2" variant="danger" label={t("trash.purgeSelected")} disabled={!selected.size || busy} onPress={() => setPurgeTarget({ ids: [...selected], all: false })} />
        <Button theme={theme} compact icon="Flame" variant="danger" label={t("trash.purgeAll")} disabled={!entries.length || busy} onPress={() => setPurgeTarget({ ids: [], all: true })} />
      </View>
      {entries.length ? (
        <View style={{ borderWidth: 1, borderColor: c.border, borderRadius: 5, overflow: "hidden" }}>
          {entries.map((entry, index) => (
            <TrashRow
              key={entry.trashId}
              theme={theme}
              entry={entry}
              locale={locale}
              last={index === entries.length - 1}
              selected={selected.has(entry.trashId)}
              busy={busy}
              onToggle={() => toggle(entry.trashId)}
              onRestore={() => void runRestore([entry.trashId])}
              onPurge={() => setPurgeTarget({ ids: [entry.trashId], all: false })}
            />
          ))}
        </View>
      ) : (
        <View style={{ alignItems: "center", padding: 44, gap: 10 }}>
          <Icon name="Trash" size={26} color={c.foregroundMuted} />
          <Text style={{ color: c.foregroundMuted, fontSize: 13 }}>{t("trash.empty")}</Text>
        </View>
      )}
      <Modal
        title={t("trash.purgeTitle")}
        icon={<Icon name="TriangleAlert" size={18} color={c.statusDanger} />}
        open={Boolean(purgeTarget)}
        onOpenChange={(open) => {
          if (!open && !purge.isPending) setPurgeTarget(null);
        }}
      >
        <Modal.Content>
          <Text style={{ color: c.foreground, fontSize: 13.5 }}>{t("trash.purgeBody", { count: purgeEntries.length, size: formatBytes(purgeBytes) })}</Text>
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
            <Button theme={theme} label={t("delete.cancel")} disabled={purge.isPending} onPress={() => setPurgeTarget(null)} />
            <Button theme={theme} variant="danger" icon="Trash2" label={t("trash.purge")} busy={purge.isPending} disabled={!purgeEntries.length} onPress={() => void runPurge()} />
          </View>
        </Modal.Content>
      </Modal>
    </View>
  );
}

function TrashRow({
  theme,
  entry,
  locale,
  last,
  selected,
  busy,
  onToggle,
  onRestore,
  onPurge,
}: {
  theme: PluginTheme;
  entry: TrashEntry;
  locale: string;
  last: boolean;
  selected: boolean;
  busy: boolean;
  onToggle(): void;
  onRestore(): void;
  onPurge(): void;
}) {
  const { t } = useTranslation(messages);
  const c = theme.colors;
  const title = entry.title || entry.sessionId || entry.trashId;
  return (
    <View
      style={{
        flexDirection: "row",
        gap: 10,
        padding: 12,
        alignItems: "flex-start",
        borderBottomWidth: last ? 0 : 1,
        borderBottomColor: c.border,
        backgroundColor: selected ? c.surface1 : "transparent",
        flexWrap: "wrap",
      }}
    >
      <View style={{ paddingTop: 3 }}>
        <Checkbox theme={theme} checked={selected} label={t("list.select", { title })} onToggle={onToggle} />
      </View>
      <View style={{ flex: 1, minWidth: 200, gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <ProviderTag theme={theme} provider={entry.provider} />
          <Text numberOfLines={1} style={{ flex: 1, color: c.foreground, fontSize: 13.5, fontWeight: "600" }}>
            {title}
          </Text>
        </View>
        {entry.cwd ? (
          <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 11.5, fontFamily: "monospace" }}>
            {entry.cwd}
          </Text>
        ) : null}
        <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Text style={{ color: c.foregroundMuted, fontSize: 11.5, fontFamily: "monospace" }}>{t("trash.deletedAt", { date: formatDateTime(entry.deletedAt, locale) })}</Text>
          <Text style={{ color: c.foregroundMuted, fontSize: 11.5, fontVariant: ["tabular-nums"] }}>{t("trash.files", { count: entry.files })}</Text>
          <Text style={{ color: c.foregroundMuted, fontSize: 11.5, fontFamily: "monospace", fontVariant: ["tabular-nums"] }}>{formatBytes(entry.bytes)}</Text>
          {entry.status === "incomplete" ? <Badge theme={theme} tone="warning" label={t("trash.incomplete")} /> : null}
          {entry.status === "invalid" ? <Badge theme={theme} tone="danger" label={t("trash.invalid")} /> : null}
        </View>
      </View>
      <View style={{ flexDirection: "row", gap: 6 }}>
        <Button theme={theme} compact icon="RotateCcw" label={t("trash.restore")} disabled={busy || entry.status === "invalid"} onPress={onRestore} />
        <Button theme={theme} compact iconOnly icon="Trash2" variant="danger" label={t("trash.purge")} disabled={busy} onPress={onPurge} />
      </View>
    </View>
  );
}
