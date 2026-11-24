import { useRpc } from "@getpaseo/plugin/client";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  deleteSessions,
  listSessions,
  listTrash,
  previewDelete,
  purgeTrash,
  restoreTrash,
  sessionDetail,
} from "../shared/contracts";
import { hostKey } from "../shared/format";
import type { ListInput } from "../shared/schema";

/**
 * Query hooks. Paseo gives each host its own query client; keys still start with the host ID so
 * data from one host can never be shown for another.
 */

export function useSessionList(hostId: string, input: ListInput) {
  const list = useRpc(listSessions);
  return useQuery({
    queryKey: hostKey(hostId, "list", input),
    queryFn: () => list(input),
    placeholderData: keepPreviousData,
    staleTime: 10_000,
    // Poll quickly while the first scan runs, then refresh periodically and after reconnects.
    refetchInterval: (query) => (query.state.data?.scanning ? 1500 : 30_000),
    retry: 2,
  });
}

export function useRefresh(hostId: string, input: ListInput) {
  const list = useRpc(listSessions);
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => list({ ...input, refresh: true }),
    onSuccess: (data) => {
      client.setQueryData(hostKey(hostId, "list", input), data);
      void client.invalidateQueries({ queryKey: hostKey(hostId) });
    },
  });
}

export function useSessionDetail(hostId: string, key: string | null) {
  const detail = useRpc(sessionDetail);
  return useQuery({
    queryKey: hostKey(hostId, "detail", key),
    queryFn: () => detail({ key: key ?? "" }),
    enabled: Boolean(key),
    staleTime: 10_000,
    retry: 1,
  });
}

export function useDeletePreview(hostId: string, keys: string[] | null) {
  const preview = useRpc(previewDelete);
  return useQuery({
    queryKey: hostKey(hostId, "preview", keys),
    queryFn: () => preview({ keys: keys ?? [] }),
    enabled: Boolean(keys?.length),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

export function useDeleteSessions(hostId: string) {
  const remove = useRpc(deleteSessions);
  const client = useQueryClient();
  return useMutation({
    mutationFn: (items: { key: string; fingerprint: string }[]) => remove({ items, confirm: true }),
    onSettled: () => client.invalidateQueries({ queryKey: hostKey(hostId) }),
  });
}

export function useTrash(hostId: string, enabled: boolean) {
  const list = useRpc(listTrash);
  return useQuery({
    queryKey: hostKey(hostId, "trash"),
    queryFn: () => list({}),
    enabled,
    staleTime: 10_000,
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    retry: 2,
  });
}

export function useRestore(hostId: string) {
  const restore = useRpc(restoreTrash);
  const client = useQueryClient();
  return useMutation({
    mutationFn: (trashIds: string[]) => restore({ trashIds }),
    onSettled: () => client.invalidateQueries({ queryKey: hostKey(hostId) }),
  });
}

export function usePurge(hostId: string) {
  const purge = useRpc(purgeTrash);
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: { trashIds: string[]; all: boolean }) => purge({ ...input, confirm: true }),
    onSettled: () => client.invalidateQueries({ queryKey: hostKey(hostId) }),
  });
}
