import type { Assistant, CalibrationPick, DeliveryPreset, ProfileView, PutReviewInput, UpdateProfileInput } from "@fs/schema";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrap } from "./api";

export const PROFILE_KEY = ["me", "profile"] as const;

export function useProfile({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: PROFILE_KEY,
    queryFn: async () => (await unwrap(api.me.preferences.$get())).profile,
    enabled,
  });
}

/** Mutations that answer with the whole profile write it straight into the cache. */
function useProfileMutation<T>(mutationFn: (input: T) => Promise<ProfileView>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn, onSuccess: (profile) => qc.setQueryData(PROFILE_KEY, profile) });
}

export function useUpdateProfile() {
  return useProfileMutation(async (input: UpdateProfileInput) => (await unwrap(api.me.preferences.$put({ json: input }))).profile);
}

/** The device's time zone, so letters arrive at the chosen local time. */
export function deviceTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function useUpdateSchedule() {
  return useProfileMutation(
    async (preset: DeliveryPreset) => (await unwrap(api.me.schedule.$put({ json: { preset, timeZone: deviceTimeZone() } }))).profile,
  );
}

export function useCompleteOnboarding() {
  return useProfileMutation(async () => (await unwrap(api.me.onboarding.complete.$post())).profile);
}

export function useImportProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { assistant: Assistant; text: string }) => (await unwrap(api.me.onboarding.import.$post({ json: input }))).result,
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["me", "onboarding", "import", "latest"] }),
  });
}

/** The last note the user pasted, saved with its import. */
export function useLatestImport({ enabled }: { enabled: boolean }) {
  return useQuery({
    queryKey: ["me", "onboarding", "import", "latest"],
    queryFn: async () => (await unwrap(api.me.onboarding.import.latest.$get())).import,
    enabled,
  });
}

export function useCalibrationPicks({ enabled }: { enabled: boolean }) {
  return useQuery<CalibrationPick[]>({
    queryKey: ["me", "onboarding", "picks"],
    queryFn: async () => (await unwrap(api.me.onboarding.picks.$get())).picks,
    enabled,
    // The deck shouldn't reshuffle under the user's thumb.
    staleTime: Infinity,
  });
}

export function useReview() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ itemId, ...json }: { itemId: string } & Partial<PutReviewInput> & Pick<PutReviewInput, "vote">) =>
      (await unwrap(api.items[":id"].review.$put({ param: { id: itemId }, json }))).review,
    // A verdict rewrites the letter's P.S. recap, so the letter is refetched for it.
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["letters"] }),
  });
}
