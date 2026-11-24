import type { PluginTheme } from "@getpaseo/plugin";
import { useHosts, useTranslation, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { formatBytes } from "../shared/format";
import {
  PAGE_SIZES,
  PROVIDERS,
  type HealthFilter,
  type ListInput,
  type OperationOutput,
  type OriginFilter,
  type ProjectSummary,
  type ProviderCounts,
  type ProviderFilter,
  type SortKey,
  type StateFilter,
} from "../shared/schema";
import { useRefresh, useSessionList } from "./data";
import { DeleteDialog } from "./delete-dialog";
import { DetailPane } from "./detail-pane";
import { errorText, formatTime } from "./format";
import { messages } from "./messages";
import { SessionList } from "./session-list";
import { TrashView } from "./trash-view";
import { Banner, Button, ProviderDot, Select, providerTone, toneColor, type SelectOption } from "./ui";

interface Filters {
  provider: ProviderFilter;
  state: StateFilter;
  health: HealthFilter;
  origin: OriginFilter;
  sort: SortKey;
  direction: "asc" | "desc";
  pageSize: number;
}
const DEFAULT_FILTERS: Filters = {
  provider: "all",
  state: "all",
  health: "all",
  origin: "all",
  sort: "updated",
  direction: "desc",
  pageSize: 50,
};

/** View preferences survive leaving the screen, per host, for the app session. */
const remembered = new Map<string, { filters: Filters; projectKey: string | null }>();

const WIDE = 1080;
const MEDIUM = 720;

function baseName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

export function SessionManagerScreen(props: PluginScreenProps) {
  // Keyed by host: switching hosts in the header resets selection and never shows another host's data.
  return <ManagerView key={props.host.id} {...props} />;
}

function ManagerView({ theme, layout, host, navigation }: PluginScreenProps) {
  const { t, locale } = useTranslation(messages);
  const c = theme.colors;
  const saved = remembered.get(host.id);
  const [tab, setTab] = useState<"sessions" | "trash">("sessions");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Filters>(saved?.filters ?? DEFAULT_FILTERS);
  const [projectKey, setProjectKey] = useState<string | null>(saved?.projectKey ?? null);
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [deleteKeys, setDeleteKeys] = useState<string[] | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);
  useEffect(() => {
    remembered.set(host.id, { filters, projectKey });
  }, [host.id, filters, projectKey]);

  const input: ListInput = useMemo(
    () => ({
      provider: filters.provider,
      search,
      projectKey,
      state: filters.state,
      health: filters.health,
      origin: filters.origin,
      sort: filters.sort,
      direction: filters.direction,
      page,
      pageSize: filters.pageSize,
    }),
    [search, projectKey, filters, page],
  );
  const list = useSessionList(host.id, input);
  const refresh = useRefresh(host.id, input);
  const hosts = useHosts();
  const hostStatus = hosts.find((candidate) => candidate.serverId === host.id)?.status;
  const data = list.data;

  const mode = layout.compact || (width > 0 && width < MEDIUM) ? "compact" : width >= WIDE ? "wide" : "medium";
  const wide = mode === "wide";

  const changeFilters = (patch: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setPage(0);
  };
  const changeProvider = (provider: ProviderFilter) => {
    setFilters((current) => ({ ...current, provider }));
    setProjectKey(null);
    setPage(0);
  };
  const changeProject = (key: string | null) => {
    setProjectKey(key);
    setPage(0);
  };
  const resetFilters = () => {
    setSearchInput("");
    setSearch("");
    setFilters(DEFAULT_FILTERS);
    setProjectKey(null);
    setPage(0);
  };

  const hasActiveFilters =
    Boolean(search) ||
    Boolean(projectKey) ||
    filters.provider !== "all" ||
    filters.state !== "all" ||
    filters.health !== "all" ||
    filters.origin !== "all";

  const toggle = useCallback((key: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const open = useCallback((key: string) => setActiveKey(key), []);
  const items = data?.items ?? [];
  const togglePage = () => {
    setSelected((current) => {
      const next = new Set(current);
      const all = items.every((item) => next.has(item.key));
      for (const item of items) {
        if (all) next.delete(item.key);
        else next.add(item.key);
      }
      return next;
    });
  };
  const requestDelete = (keys: string[]) => {
    if (!wide) setActiveKey(null);
    setDeleteKeys(keys);
  };
  const onDeleted = (result: OperationOutput) => {
    const removed = new Set(result.results.filter((item) => item.ok).map((item) => item.id));
    setSelected((current) => new Set([...current].filter((key) => !removed.has(key))));
    if (activeKey && removed.has(activeKey)) setActiveKey(null);
    setDeleteKeys(null);
  };

  const stats = data?.stats;
  const scanning = data?.scanning;
  const offline = hostStatus !== undefined && hostStatus !== "online";

  const stateOptions: SelectOption<StateFilter>[] = [
    { value: "all", label: t("filter.stateAll") },
    { value: "active", label: t("filter.stateActive") },
    { value: "idle", label: t("filter.stateIdle") },
  ];
  const healthOptions: SelectOption<HealthFilter>[] = [
    { value: "all", label: t("filter.healthAll") },
    { value: "ok", label: t("filter.healthOk") },
    { value: "damaged", label: t("filter.healthDamaged") },
    { value: "empty", label: t("filter.healthEmpty") },
  ];
  const originOptions: SelectOption<OriginFilter>[] = [
    { value: "all", label: t("filter.originAll") },
    { value: "paseo", label: t("filter.originPaseo") },
    { value: "native", label: t("filter.originNative") },
  ];
  const sortOptions: SelectOption<SortKey>[] = [
    { value: "updated", label: t("filter.sortUpdated") },
    { value: "started", label: t("filter.sortStarted") },
    { value: "size", label: t("filter.sortSize") },
    { value: "messages", label: t("filter.sortMessages") },
    { value: "title", label: t("filter.sortTitle") },
  ];
  const pageSizeOptions: SelectOption<string>[] = PAGE_SIZES.map((size) => ({ value: String(size), label: t("filter.pageSize", { count: size }) }));
  const projects = data?.projects ?? [];
  const projectOptions: SelectOption<string>[] = [
    { value: "", label: t("projects.all") },
    ...projects.map((project) => ({ value: project.key, label: baseName(project.path), hint: project.path })),
  ];

  const px = mode === "compact" ? 12 : 16;

  const header = (
    <View style={{ backgroundColor: c.surface0, borderBottomWidth: 1, borderBottomColor: c.border }}>
      {/* Top Command Bar */}
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap", paddingHorizontal: px, paddingVertical: mode === "compact" ? 10 : 12 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View
            style={{
              width: 28,
              height: 28,
              borderRadius: 5,
              borderWidth: 1,
              borderColor: c.border,
              backgroundColor: c.surface1,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Icon name="History" size={16} color={c.accent} />
          </View>
          <Text style={{ color: c.foreground, fontSize: mode === "compact" ? 16 : 17, fontWeight: "700", letterSpacing: -0.2 }}>{t("app.title")}</Text>
        </View>
        <HostChip theme={theme} label={host.label} status={hostStatus} statusLabel={hostStatus ? t(`host.${hostStatus}`) : ""} />
        <View style={{ flex: 1 }} />
        <Tabs theme={theme} tab={tab} onTab={setTab} sessionsLabel={t("toolbar.sessions")} trashLabel={t("toolbar.trash", { count: stats?.trashEntries ?? 0 })} />
        <Button theme={theme} compact iconOnly={mode === "compact"} icon="RefreshCw" label={t("toolbar.refresh")} busy={refresh.isPending} onPress={() => refresh.mutate()} />
      </View>

      {/* Industrial Telemetry Strip */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          flexWrap: "wrap",
          gap: mode === "compact" ? 10 : 16,
          paddingHorizontal: px,
          paddingVertical: 7,
          borderTopWidth: 1,
          borderTopColor: c.border,
          backgroundColor: c.surface1,
        }}
      >
        <TelemetryItem theme={theme} label={t("telemetry.sessions")} value={String(stats?.sessions ?? 0)} />
        <TelemetryDivider theme={theme} />
        <TelemetryItem theme={theme} label={t("telemetry.projects")} value={String(stats?.projects ?? 0)} />
        <TelemetryDivider theme={theme} />
        <TelemetryItem theme={theme} label={t("telemetry.storage")} value={formatBytes(stats?.bytes ?? 0)} mono />
        {stats && stats.active > 0 ? (
          <>
            <TelemetryDivider theme={theme} />
            <TelemetryItem theme={theme} label={t("telemetry.active")} value={String(stats.active)} valueColor={c.statusSuccess} />
          </>
        ) : null}
        {stats && stats.damaged > 0 ? (
          <>
            <TelemetryDivider theme={theme} />
            <TelemetryItem theme={theme} label={t("telemetry.damaged")} value={String(stats.damaged)} valueColor={c.statusDanger} />
          </>
        ) : null}
        <View style={{ flex: 1 }} />
        {scanning ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <ActivityIndicator size="small" color={c.accent} />
            <Text style={{ color: c.foregroundMuted, fontSize: 11, fontFamily: "monospace", fontVariant: ["tabular-nums"] }}>
              {t("status.scanning", { done: scanning.done, total: scanning.total || "…" })}
            </Text>
          </View>
        ) : data?.scannedAt ? (
          <Text style={{ color: c.foregroundMuted, fontSize: 11, fontFamily: "monospace", fontVariant: ["tabular-nums"] }}>
            {t("status.updated", { time: formatTime(data.scannedAt, locale) })}
          </Text>
        ) : null}
      </View>

      {/* Provider Switcher + Search & Filter Bar */}
      {tab === "sessions" ? (
        <View style={{ gap: 8, paddingHorizontal: px, paddingVertical: 10, borderTopWidth: 1, borderTopColor: c.border }}>
          <View style={{ flexDirection: mode === "compact" ? "column" : "row", alignItems: mode === "compact" ? "stretch" : "center", gap: 8 }}>
            <ProviderBar
              theme={theme}
              value={filters.provider}
              total={stats?.sessions ?? 0}
              counts={stats?.byProvider}
              onChange={changeProvider}
              labels={{
                all: t("provider.all"),
                claude: t("provider.claude"),
                codex: t("provider.codex"),
                antigravity: t("provider.antigravity"),
              }}
            />
            <View
              style={{
                flex: mode === "compact" ? undefined : 1,
                minWidth: mode === "compact" ? undefined : 220,
                flexDirection: "row",
                alignItems: "center",
                gap: 8,
                minHeight: 32,
                paddingHorizontal: 10,
                borderRadius: 5,
                borderWidth: 1,
                borderColor: searchInput ? c.accent : c.border,
                backgroundColor: c.surface1,
              }}
            >
              <Icon name="Search" size={14} color={c.foregroundMuted} />
              <TextInput
                value={searchInput}
                onChangeText={setSearchInput}
                placeholder={t("toolbar.search")}
                placeholderTextColor={c.foregroundMuted}
                accessibilityLabel={t("toolbar.search")}
                autoCapitalize="none"
                autoCorrect={false}
                returnKeyType="search"
                style={{ flex: 1, color: c.foreground, fontSize: 13, paddingVertical: 6 }}
              />
              {searchInput ? (
                <Pressable accessibilityRole="button" accessibilityLabel={t("toolbar.clearSearch")} hitSlop={8} onPress={() => setSearchInput("")}>
                  <Icon name="X" size={14} color={c.foregroundMuted} />
                </Pressable>
              ) : null}
            </View>
          </View>

          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 6, alignItems: "center" }} style={{ flexGrow: 0 }}>
            {mode !== "wide" ? (
              <Select
                theme={theme}
                compact
                label={t("filter.project")}
                value={projectKey ?? ""}
                options={projectOptions}
                highlighted={Boolean(projectKey)}
                onChange={(value) => changeProject(value || null)}
              />
            ) : null}
            <Select theme={theme} compact label={t("filter.state")} value={filters.state} options={stateOptions} highlighted={filters.state !== "all"} onChange={(state) => changeFilters({ state })} />
            <Select theme={theme} compact label={t("filter.health")} value={filters.health} options={healthOptions} highlighted={filters.health !== "all"} onChange={(health) => changeFilters({ health })} />
            <Select theme={theme} compact label={t("filter.origin")} value={filters.origin} options={originOptions} highlighted={filters.origin !== "all"} onChange={(origin) => changeFilters({ origin })} />
            <Select theme={theme} compact label={t("filter.sort")} value={filters.sort} options={sortOptions} onChange={(sort) => changeFilters({ sort })} />
            <Button
              theme={theme}
              compact
              iconOnly
              icon={filters.direction === "desc" ? "ArrowDownWideNarrow" : "ArrowUpNarrowWide"}
              label={filters.direction === "desc" ? t("filter.descending") : t("filter.ascending")}
              onPress={() => changeFilters({ direction: filters.direction === "desc" ? "asc" : "desc" })}
            />
            <Select theme={theme} compact label={t("filter.perPage")} value={String(filters.pageSize)} options={pageSizeOptions} onChange={(value) => changeFilters({ pageSize: Number(value) })} />
            {hasActiveFilters ? <Button theme={theme} compact variant="ghost" icon="X" label={t("filter.reset")} onPress={resetFilters} /> : null}
          </ScrollView>
        </View>
      ) : null}

      {offline && data ? (
        <View style={{ paddingHorizontal: px, paddingBottom: 10 }}>
          <Banner theme={theme} tone="warning" text={t("status.offline")} />
        </View>
      ) : null}
      {list.isError ? (
        <View style={{ paddingHorizontal: px, paddingBottom: 10 }}>
          <Banner theme={theme} tone="danger" text={t("status.error", { message: errorText(list.error) })} action={<Button theme={theme} compact label={t("status.retry")} onPress={() => void list.refetch()} />} />
        </View>
      ) : null}
      {data?.warnings.length ? (
        <View style={{ paddingHorizontal: px, paddingBottom: 10 }}>
          <Banner
            theme={theme}
            tone="warning"
            text={data.warnings
              .slice(0, 3)
              .map((warning) => t(`warning.${warning.code}`, { path: warning.path }))
              .join("\n")}
          />
        </View>
      ) : null}
    </View>
  );

  const listPane = (
    <SessionList
      theme={theme}
      compact={mode === "compact"}
      items={items}
      total={data?.total ?? 0}
      page={data?.page ?? page}
      pageSize={data?.pageSize ?? filters.pageSize}
      selected={selected}
      activeKey={activeKey}
      showProject={!projectKey}
      emptyHost={Boolean(data && data.stats.sessions === 0)}
      onToggle={toggle}
      onTogglePage={togglePage}
      onClearSelection={() => setSelected(new Set())}
      onDeleteSelected={() => requestDelete([...selected])}
      onOpen={open}
      onPage={setPage}
    />
  );
  const openAgent = navigation ? (agentId: string) => navigation.openAgent({ agentId }) : undefined;
  const detail = <DetailPane theme={theme} hostId={host.id} sessionKey={activeKey} onDelete={(key) => requestDelete([key])} onOpenSession={open} openAgent={openAgent} />;

  const providerTotal = filters.provider === "all" ? (stats?.sessions ?? 0) : (stats?.byProvider[filters.provider] ?? 0);

  return (
    <View style={{ flex: 1, backgroundColor: c.surface0 }} onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
      {header}
      {tab === "trash" ? (
        <ScrollView style={{ flex: 1 }}>
          <TrashView theme={theme} hostId={host.id} compact={mode === "compact"} />
        </ScrollView>
      ) : list.isPending && !data ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          <ActivityIndicator color={c.foregroundMuted} />
        </View>
      ) : (
        <View style={{ flex: 1, flexDirection: "row", minHeight: 0 }}>
          {mode !== "compact" ? (
            <ProjectNav theme={theme} width={wide ? 248 : 210} projects={projects} total={providerTotal} active={projectKey} onSelect={changeProject} />
          ) : null}
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }}>
            {listPane}
          </ScrollView>
          {wide ? (
            <View style={{ width: 428, borderLeftWidth: 1, borderLeftColor: c.border, backgroundColor: c.surface0 }}>
              <ScrollView style={{ flex: 1 }}>{detail}</ScrollView>
            </View>
          ) : null}
        </View>
      )}
      {!wide ? (
        <Modal title={t("detail.title")} open={Boolean(activeKey)} onOpenChange={(value) => (value ? undefined : setActiveKey(null))}>
          <Modal.Content contentContainerStyle={{ padding: 0, gap: 0 }}>{detail}</Modal.Content>
        </Modal>
      ) : null}
      <DeleteDialog theme={theme} hostId={host.id} keys={deleteKeys} onClose={() => setDeleteKeys(null)} onDeleted={onDeleted} />
    </View>
  );
}

function TelemetryItem({ theme, label, value, mono, valueColor }: { theme: PluginTheme; label: string; value: string; mono?: boolean; valueColor?: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "700", letterSpacing: 0.6, textTransform: "uppercase" }}>{label}</Text>
      <Text
        style={{
          color: valueColor ?? theme.colors.foreground,
          fontSize: 12,
          fontWeight: "700",
          fontFamily: mono ? "monospace" : undefined,
          fontVariant: ["tabular-nums"],
        }}
      >
        {value}
      </Text>
    </View>
  );
}

function TelemetryDivider({ theme }: { theme: PluginTheme }) {
  return <View style={{ width: 1, height: 12, backgroundColor: theme.colors.border }} />;
}

function ProviderBar({
  theme,
  value,
  total,
  counts,
  onChange,
  labels,
}: {
  theme: PluginTheme;
  value: ProviderFilter;
  total: number;
  counts?: ProviderCounts;
  onChange(value: ProviderFilter): void;
  labels: Record<ProviderFilter, string>;
}) {
  const c = theme.colors;
  const items: { id: ProviderFilter; count: number; accent?: string }[] = [
    { id: "all", count: total },
    ...PROVIDERS.map((provider) => ({
      id: provider as ProviderFilter,
      count: counts?.[provider] ?? 0,
      accent: toneColor(theme, providerTone(provider)),
    })),
  ];
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ alignItems: "center" }}>
      <View
        accessibilityRole="tablist"
        style={{
          flexDirection: "row",
          padding: 2,
          borderRadius: 5,
          borderWidth: 1,
          borderColor: c.border,
          backgroundColor: c.surface1,
          gap: 2,
        }}
      >
        {items.map((item) => {
          const active = value === item.id;
          return (
            <Pressable
              key={item.id}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              onPress={() => onChange(item.id)}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                paddingHorizontal: 9,
                paddingVertical: 5,
                borderRadius: 4,
                backgroundColor: active ? c.surface2 : pressed ? c.surface0 : "transparent",
                borderWidth: 1,
                borderColor: active ? c.border : "transparent",
              })}
            >
              {item.accent ? <View style={{ width: 6, height: 6, borderRadius: 2, backgroundColor: item.accent }} /> : null}
              <Text style={{ color: active ? c.foreground : c.foregroundMuted, fontSize: 12, fontWeight: active ? "700" : "500" }}>{labels[item.id]}</Text>
              <Text style={{ color: active ? c.foreground : c.foregroundMuted, fontSize: 11, fontFamily: "monospace", fontVariant: ["tabular-nums"] }}>
                {item.count}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </ScrollView>
  );
}

function HostChip({ theme, label, status, statusLabel }: { theme: PluginTheme; label: string; status?: string; statusLabel: string }) {
  const c = theme.colors;
  const dot = status === "online" ? c.statusSuccess : status === "connecting" || status === "idle" ? c.statusWarning : status ? c.statusDanger : c.foregroundMuted;
  return (
    <View
      accessible
      accessibilityLabel={statusLabel ? `${label}, ${statusLabel}` : label}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 6,
        paddingHorizontal: 8,
        paddingVertical: 4,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: c.border,
        backgroundColor: c.surface1,
        maxWidth: 240,
      }}
    >
      <Icon name="Server" size={12} color={c.foregroundMuted} />
      <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 11.5, fontWeight: "600", fontFamily: "monospace", flexShrink: 1 }}>
        {label}
      </Text>
      {status ? <View style={{ width: 6, height: 6, borderRadius: 2, backgroundColor: dot }} /> : null}
      {statusLabel && status !== "online" ? <Text style={{ color: c.foregroundMuted, fontSize: 10.5 }}>{statusLabel}</Text> : null}
    </View>
  );
}

function Tabs({ theme, tab, onTab, sessionsLabel, trashLabel }: { theme: PluginTheme; tab: "sessions" | "trash"; onTab(tab: "sessions" | "trash"): void; sessionsLabel: string; trashLabel: string }) {
  const c = theme.colors;
  const item = (value: "sessions" | "trash", label: string, icon: string) => (
    <Pressable
      key={value}
      accessibilityRole="tab"
      accessibilityState={{ selected: tab === value }}
      onPress={() => onTab(value)}
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 4,
        backgroundColor: tab === value ? c.surface2 : "transparent",
        borderWidth: 1,
        borderColor: tab === value ? c.border : "transparent",
      }}
    >
      <Icon name={icon} size={13} color={tab === value ? c.foreground : c.foregroundMuted} />
      <Text style={{ color: tab === value ? c.foreground : c.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: "row", padding: 2, borderRadius: 5, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, gap: 2 }}>
      {item("sessions", sessionsLabel, "MessagesSquare")}
      {item("trash", trashLabel, "Trash2")}
    </View>
  );
}

function ProjectNav({ theme, width, projects, total, active, onSelect }: { theme: PluginTheme; width: number; projects: ProjectSummary[]; total: number; active: string | null; onSelect(key: string | null): void }) {
  const { t } = useTranslation(messages);
  const c = theme.colors;
  const row = (key: string | null, title: string, subtitle: string | null, count: string, providers?: ProjectSummary["providers"]) => {
    const selected = active === key;
    return (
      <Pressable
        key={key ?? "all"}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={`${title}, ${count}`}
        onPress={() => onSelect(key)}
        style={({ pressed }) => ({
          paddingHorizontal: 10,
          paddingVertical: 8,
          borderRadius: 4,
          borderLeftWidth: 2,
          borderLeftColor: selected ? c.accent : "transparent",
          gap: 3,
          backgroundColor: selected ? c.surface2 : pressed ? c.surface1 : "transparent",
        })}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 7 }}>
          <Icon name={key ? (selected ? "FolderOpen" : "Folder") : "Layers"} size={13} color={selected ? c.accent : c.foregroundMuted} />
          <Text numberOfLines={1} style={{ flex: 1, color: c.foreground, fontSize: 12.5, fontWeight: selected ? "700" : "500" }}>
            {title}
          </Text>
          <Text style={{ color: selected ? c.foreground : c.foregroundMuted, fontSize: 11, fontFamily: "monospace", fontVariant: ["tabular-nums"] }}>{count}</Text>
        </View>
        {subtitle || (providers && providers.length > 0) ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 20 }}>
            {subtitle ? (
              <Text numberOfLines={1} style={{ flex: 1, color: c.foregroundMuted, fontSize: 10.5, fontFamily: "monospace" }}>
                {subtitle}
              </Text>
            ) : (
              <View style={{ flex: 1 }} />
            )}
            {providers && providers.length > 0 ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
                {providers.map((provider) => (
                  <ProviderDot key={provider} theme={theme} provider={provider} />
                ))}
              </View>
            ) : null}
          </View>
        ) : null}
      </Pressable>
    );
  };
  return (
    <View style={{ width, borderRightWidth: 1, borderRightColor: c.border, backgroundColor: c.surface0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6, borderBottomWidth: 1, borderBottomColor: c.border }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 10, fontWeight: "700", letterSpacing: 0.7, textTransform: "uppercase" }}>{t("projects.title")}</Text>
        <Text style={{ color: c.foregroundMuted, fontSize: 10.5, fontFamily: "monospace", fontVariant: ["tabular-nums"] }}>{projects.length}</Text>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 6, gap: 2 }}>
        {row(null, t("projects.all"), null, String(total))}
        {projects.map((project) =>
          row(
            project.key,
            baseName(project.path),
            project.path,
            project.matching === project.sessions ? String(project.sessions) : t("projects.count", { matching: project.matching, total: project.sessions }),
            project.providers,
          ),
        )}
      </ScrollView>
    </View>
  );
}
