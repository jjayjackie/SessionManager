import type { PluginTheme } from "@getpaseo/plugin";
import { useHosts, useTranslation, type PluginScreenProps } from "@getpaseo/plugin/client";
import { Icon, Modal, ScrollView, TextInput } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { formatBytes } from "../shared/format";
import { PAGE_SIZES, type HealthFilter, type ListInput, type OperationOutput, type OriginFilter, type ProjectSummary, type SortKey, type StateFilter } from "../shared/schema";
import { useRefresh, useSessionList } from "./data";
import { DeleteDialog } from "./delete-dialog";
import { DetailPane } from "./detail-pane";
import { errorText, formatTime } from "./format";
import { messages } from "./messages";
import { SessionList } from "./session-list";
import { TrashView } from "./trash-view";
import { Banner, Button, Select, type SelectOption } from "./ui";

interface Filters {
  state: StateFilter;
  health: HealthFilter;
  origin: OriginFilter;
  sort: SortKey;
  direction: "asc" | "desc";
  pageSize: number;
}
const DEFAULT_FILTERS: Filters = { state: "all", health: "all", origin: "all", sort: "updated", direction: "desc", pageSize: 50 };

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
    () => ({ search, projectKey, state: filters.state, health: filters.health, origin: filters.origin, sort: filters.sort, direction: filters.direction, page, pageSize: filters.pageSize }),
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
  const changeProject = (key: string | null) => {
    setProjectKey(key);
    setPage(0);
  };
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
  const statsLine = stats
    ? [
        t("stats.sessions", { count: stats.sessions }),
        t("stats.projects", { count: stats.projects }),
        formatBytes(stats.bytes),
        stats.active ? t("stats.active", { count: stats.active }) : null,
        stats.damaged ? t("stats.damaged", { count: stats.damaged }) : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "";
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

  const header = (
    <View style={{ gap: 10, paddingHorizontal: mode === "compact" ? 12 : 18, paddingTop: mode === "compact" ? 12 : 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: c.border, backgroundColor: c.surface0 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Icon name="History" size={20} color={c.accent} />
        <Text style={{ color: c.foreground, fontSize: mode === "compact" ? 17 : 19, fontWeight: "700" }}>{t("app.title")}</Text>
        <HostChip theme={theme} label={host.label} status={hostStatus} statusLabel={hostStatus ? t(`host.${hostStatus}`) : ""} />
        <View style={{ flex: 1 }} />
        <Tabs theme={theme} tab={tab} onTab={setTab} sessionsLabel={t("toolbar.sessions")} trashLabel={t("toolbar.trash", { count: stats?.trashEntries ?? 0 })} />
        <Button theme={theme} compact iconOnly={mode === "compact"} icon="RefreshCw" label={t("toolbar.refresh")} busy={refresh.isPending} onPress={() => refresh.mutate()} />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{statsLine}</Text>
        {scanning ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <ActivityIndicator size="small" color={c.foregroundMuted} />
            <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{t("status.scanning", { done: scanning.done, total: scanning.total || "…" })}</Text>
          </View>
        ) : data?.scannedAt ? (
          <Text style={{ color: c.foregroundMuted, fontSize: 12 }}>{t("status.updated", { time: formatTime(data.scannedAt, locale) })}</Text>
        ) : null}
      </View>
      {tab === "sessions" ? (
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
            <Icon name="Search" size={16} color={c.foregroundMuted} />
            <TextInput
              value={searchInput}
              onChangeText={setSearchInput}
              placeholder={t("toolbar.search")}
              placeholderTextColor={c.foregroundMuted}
              accessibilityLabel={t("toolbar.search")}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              style={{ flex: 1, color: c.foreground, fontSize: 14, paddingVertical: 8 }}
            />
            {searchInput ? (
              <Pressable accessibilityRole="button" accessibilityLabel={t("toolbar.clearSearch")} hitSlop={8} onPress={() => setSearchInput("")}>
                <Icon name="X" size={16} color={c.foregroundMuted} />
              </Pressable>
            ) : null}
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, alignItems: "center" }} style={{ flexGrow: 0 }}>
            {mode !== "wide" ? <Select theme={theme} compact label={t("filter.project")} value={projectKey ?? ""} options={projectOptions} onChange={(value) => changeProject(value || null)} /> : null}
            <Select theme={theme} compact label={t("filter.state")} value={filters.state} options={stateOptions} onChange={(state) => changeFilters({ state })} />
            <Select theme={theme} compact label={t("filter.health")} value={filters.health} options={healthOptions} onChange={(health) => changeFilters({ health })} />
            <Select theme={theme} compact label={t("filter.origin")} value={filters.origin} options={originOptions} onChange={(origin) => changeFilters({ origin })} />
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
          </ScrollView>
        </View>
      ) : null}
      {offline && data ? <Banner theme={theme} tone="warning" text={t("status.offline")} /> : null}
      {list.isError ? (
        <Banner theme={theme} tone="danger" text={t("status.error", { message: errorText(list.error) })} action={<Button theme={theme} compact label={t("status.retry")} onPress={() => void list.refetch()} />} />
      ) : null}
      {data?.warnings.length ? (
        <Banner
          theme={theme}
          tone="warning"
          text={data.warnings
            .slice(0, 3)
            .map((warning) => t(`warning.${warning.code}`, { path: warning.path }))
            .join("\n")}
        />
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
            <ProjectNav theme={theme} width={wide ? 250 : 210} projects={projects} total={data?.stats.sessions ?? 0} active={projectKey} onSelect={changeProject} />
          ) : null}
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ flexGrow: 1 }}>
            {listPane}
          </ScrollView>
          {wide ? (
            <View style={{ width: 420, borderLeftWidth: 1, borderLeftColor: c.border, backgroundColor: c.surface0 }}>
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

function HostChip({ theme, label, status, statusLabel }: { theme: PluginTheme; label: string; status?: string; statusLabel: string }) {
  const c = theme.colors;
  const dot = status === "online" ? c.statusSuccess : status === "connecting" || status === "idle" ? c.statusWarning : status ? c.statusDanger : c.foregroundMuted;
  return (
    <View
      accessible
      accessibilityLabel={statusLabel ? `${label}, ${statusLabel}` : label}
      style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 999, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1, maxWidth: 260 }}
    >
      <Icon name="Server" size={13} color={c.foregroundMuted} />
      <Text numberOfLines={1} style={{ color: c.foreground, fontSize: 12, fontWeight: "600", flexShrink: 1 }}>
        {label}
      </Text>
      {status ? <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: dot }} /> : null}
      {statusLabel && status !== "online" ? <Text style={{ color: c.foregroundMuted, fontSize: 11 }}>{statusLabel}</Text> : null}
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
      style={{ flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 7, backgroundColor: tab === value ? c.surface2 : "transparent" }}
    >
      <Icon name={icon} size={14} color={tab === value ? c.foreground : c.foregroundMuted} />
      <Text style={{ color: tab === value ? c.foreground : c.foregroundMuted, fontSize: 12, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
  return (
    <View accessibilityRole="tablist" style={{ flexDirection: "row", padding: 3, borderRadius: 9, borderWidth: 1, borderColor: c.border, backgroundColor: c.surface1 }}>
      {item("sessions", sessionsLabel, "MessagesSquare")}
      {item("trash", trashLabel, "Trash2")}
    </View>
  );
}

function ProjectNav({ theme, width, projects, total, active, onSelect }: { theme: PluginTheme; width: number; projects: ProjectSummary[]; total: number; active: string | null; onSelect(key: string | null): void }) {
  const { t } = useTranslation(messages);
  const c = theme.colors;
  const row = (key: string | null, title: string, subtitle: string | null, count: string) => {
    const selected = active === key;
    return (
      <Pressable
        key={key ?? "all"}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityLabel={`${title}, ${count}`}
        onPress={() => onSelect(key)}
        style={({ pressed }) => ({ paddingHorizontal: 12, paddingVertical: 8, borderRadius: 8, gap: 2, backgroundColor: selected ? c.surface2 : pressed ? c.surface1 : "transparent" })}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Icon name={key ? (selected ? "FolderOpen" : "Folder") : "Layers"} size={14} color={selected ? c.accent : c.foregroundMuted} />
          <Text numberOfLines={1} style={{ flex: 1, color: c.foreground, fontSize: 13, fontWeight: selected ? "700" : "500" }}>
            {title}
          </Text>
          <Text style={{ color: c.foregroundMuted, fontSize: 11, fontVariant: ["tabular-nums"] }}>{count}</Text>
        </View>
        {subtitle ? (
          <Text numberOfLines={1} style={{ color: c.foregroundMuted, fontSize: 11, paddingLeft: 22 }}>
            {subtitle}
          </Text>
        ) : null}
      </Pressable>
    );
  };
  return (
    <View style={{ width, borderRightWidth: 1, borderRightColor: c.border, backgroundColor: c.surface0 }}>
      <Text style={{ color: c.foregroundMuted, fontSize: 11, fontWeight: "700", letterSpacing: 0.4, textTransform: "uppercase", paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6 }}>{t("projects.title")}</Text>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: 6, paddingBottom: 12, gap: 1 }}>
        {row(null, t("projects.all"), null, String(total))}
        {projects.map((project) =>
          row(project.key, baseName(project.path), project.path, project.matching === project.sessions ? String(project.sessions) : t("projects.count", { matching: project.matching, total: project.sessions })),
        )}
      </ScrollView>
    </View>
  );
}
