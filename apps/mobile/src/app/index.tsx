import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { useEffect } from "react";
import { EmptyToday } from "@/components/letter/EmptyToday";
import { LetterPager } from "@/components/letter/LetterPager";
import { PreparingLetter } from "@/components/letter/PreparingLetter";
import { PageState } from "@/components/pager/PagerScreen";
import type { ApiError } from "@/lib/api";
import { listenParams } from "@/lib/now-playing-nav";
import { inProgress, LETTER_KEYS, untrackLetter, useLetterProgress, useTodayLetter, useTrackedLetter } from "@/lib/letters";

/**
 * Today: the latest letter as pages. While a letter is being put together now
 * (the first one after onboarding, or a test letter), where it's got to, until
 * it opens here; before the first one, when it arrives.
 */
export default function Today() {
  const qc = useQueryClient();
  // The pill's row was tapped elsewhere: open at that piece, at its Listen card.
  const focus = listenParams(useLocalSearchParams<{ page?: string; listen?: string }>());
  const today = useTodayLetter();
  const trackedId = useTrackedLetter();
  const progress = useLetterProgress(trackedId);
  const stage = progress.data?.stage;

  // Sent: show it, then stop following it.
  useEffect(() => {
    if (stage !== "sent") return;
    void Promise.all([qc.invalidateQueries({ queryKey: LETTER_KEYS.today }), qc.invalidateQueries({ queryKey: LETTER_KEYS.list })]).then(untrackLetter);
  }, [stage, qc]);

  // A letter that's gone (an account reset) isn't followed any more.
  useEffect(() => {
    if (progress.isError && (progress.error as ApiError).status === 404) untrackLetter();
  }, [progress.isError, progress.error]);

  const following = !!trackedId && !progress.isError;
  if (following && (progress.isPending || inProgress(stage) || stage === "sent")) {
    return <PreparingLetter stage={stage ?? null} isTest={progress.data?.isTest ?? false} />;
  }
  if (today.isPending) return <PageState current="today" kicker="Today" />;
  if (today.isError && !today.data) return <PageState current="today" kicker="Today" error={today.error.message} onRetry={() => void today.refetch()} />;
  // It ended without a letter: say so here (with a way to try again) until another one is asked for.
  const ended = following && (stage === "empty" || stage === "failed") ? stage : null;
  if (!today.data) return <EmptyToday ended={ended} />;
  return <LetterPager letter={today.data} today focus={focus} />;
}
