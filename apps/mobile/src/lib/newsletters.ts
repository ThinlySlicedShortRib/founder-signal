import type { NewslettersView } from "@fs/schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "./api";

/**
 * Newsletters by email (docs/imports/README.md): the user's personal
 * address, forwarding confirmations that arrived at it, and the senders
 * received so far.
 */

const KEY = ["me", "newsletters"] as const;

/** Polled while the screen is open, so Gmail's confirmation code and new senders show up on their own. */
export function useNewsletters({ poll }: { poll: boolean }) {
  return useQuery({
    queryKey: KEY,
    queryFn: async () => unwrap(api.me.newsletters.$get()),
    refetchInterval: poll ? 5_000 : false,
  });
}

export function useRotateAddress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await unwrap(api.me.newsletters.address.rotate.$post())).address,
    onSuccess: (address) => {
      qc.setQueryData<NewslettersView>(KEY, (view) => (view ? { ...view, address } : view));
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
}

/** Follow or stop following a sender: its source's pause switch. */
export function useFollowSender() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ sourceId, following }: { sourceId: string; following: boolean }) =>
      unwrap(api.me.sources[":id"].$patch({ param: { id: sourceId }, json: { blocked: !following } })),
    onMutate: async ({ sourceId, following }) => {
      await qc.cancelQueries({ queryKey: KEY });
      const previous = qc.getQueryData<NewslettersView>(KEY);
      qc.setQueryData<NewslettersView>(KEY, (view) =>
        view ? { ...view, senders: view.senders.map((s) => (s.sourceId === sourceId ? { ...s, following } : s)) } : view,
      );
      return { previous };
    },
    onError: (_err, _input, ctx) => qc.setQueryData(KEY, ctx?.previous),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      void qc.invalidateQueries({ queryKey: ["me", "sources"] });
    },
  });
}
