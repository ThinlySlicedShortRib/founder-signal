import type { DevState } from "@fs/schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "./api";
import { clearLocalReadingState, LETTER_KEYS } from "./letters";
import { PROFILE_KEY } from "./profile";

/**
 * The Dev tools screen (development builds against a local API only): a
 * snapshot of the signed-in account and the pipeline, and actions that the
 * local worker (`pnpm dev:workers`) picks up from the database.
 */

export const DEV_STATE_KEY = ["dev", "state"] as const;

/** Statuses a letter ends in; anything else is still being put together. */
const FINISHED_LETTERS = new Set(["sent", "short_sent", "skipped_no_candidates", "failed", "skipped"]);
export const letterInProgress = (status: string) => !FINISHED_LETTERS.has(status);
export const runInProgress = (status: string) => status === "pending" || status === "running";

/** Something the worker should be moving. */
export function isBusy(state: DevState | undefined): boolean {
  return !!state && (state.letters.some((l) => letterInProgress(l.status)) || state.discoveryRuns.some((r) => runInProgress(r.status)));
}

/** How long work can wait before the screen suggests the worker isn't running. */
const STALL_MS = 20_000;

/** A letter or run has waited a while and the worker hasn't done anything since it was asked. */
export function looksStalled(state: DevState | undefined, now = Date.now()): boolean {
  if (!state) return false;
  const last = state.lastWorkerActivityAt ? new Date(state.lastWorkerActivityAt).getTime() : 0;
  const waiting = [
    ...state.letters.filter((l) => l.status === "scheduled" && !l.waitingOnDiscovery).map((l) => l.createdAt),
    ...state.discoveryRuns.filter((r) => r.status === "pending").map((r) => r.createdAt),
  ].map((at) => new Date(at).getTime());
  return waiting.some((at) => now - at > STALL_MS && last < at);
}

export function useDevState() {
  return useQuery({
    queryKey: DEV_STATE_KEY,
    queryFn: async () => (await unwrap(api.dev.state.$get())).state,
    staleTime: 0,
    // Follows the pipeline while it's working.
    refetchInterval: (q) => (isBusy(q.state.data) ? 3_000 : false),
  });
}

/** Mutations that change what the snapshot shows refresh it, and whatever else they name. */
function useDevMutation<T, R>(mutationFn: (input: T) => Promise<R>, also: (readonly unknown[])[] = []) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => {
      for (const queryKey of [DEV_STATE_KEY, ...also]) void qc.invalidateQueries({ queryKey });
    },
  });
}

export function useDevLetter() {
  return useDevMutation(async (input: { discoverFirst: boolean }) => unwrap(api.dev.letter.$post({ json: input })), [LETTER_KEYS.today]);
}

export function useDevDiscovery() {
  return useDevMutation(async () => unwrap(api.dev.discovery.$post()));
}

export function useForgetLetters() {
  return useDevMutation(
    async (input: { includeReviews: boolean }) => {
      const out = await unwrap(api.dev.letters.forget.$post({ json: input }));
      // Saved, finished and verdicts were laid over the server's state; those events are gone now.
      clearLocalReadingState();
      return out;
    },
    [["letters"], ["items"], ["me", "saved"], ["me", "activity"]],
  );
}

export function useRefreshSources() {
  return useDevMutation(async () => unwrap(api.dev.sources.refresh.$post()), [["me", "sources"]]);
}

/** Onboarding runs again with the user's answers filled in: the profile is written into the cache, and the app's guard opens onboarding. */
export function useRestartOnboarding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await unwrap(api.dev.onboarding.restart.$post())).profile,
    onSuccess: (profile) => {
      qc.setQueryData(PROFILE_KEY, profile);
      void qc.invalidateQueries({ queryKey: ["me", "onboarding"] });
    },
  });
}

/** A brand-new account under the same sign-in: every cached answer goes. */
export function useResetAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await unwrap(api.dev.reset.$post())).profile,
    onSuccess: (profile) => {
      clearLocalReadingState();
      qc.clear();
      qc.setQueryData(PROFILE_KEY, profile);
    },
  });
}
