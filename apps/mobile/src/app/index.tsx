import { useEffect, useState } from "react";
import { EmptyToday } from "@/components/letter/EmptyToday";
import { LetterPager } from "@/components/letter/LetterPager";
import { PageState } from "@/components/pager/PagerScreen";
import { useTodayLetter } from "@/lib/letters";

/** How long to wait for a test letter before giving up polling. */
const POLL_FOR_MS = 3 * 60_000;

/** Today: the latest letter as pages, or, before the first one, when it arrives. */
export default function Today() {
  const [polling, setPolling] = useState(false);
  const today = useTodayLetter({ poll: polling });

  useEffect(() => {
    if (!polling) return;
    const t = setTimeout(() => setPolling(false), POLL_FOR_MS);
    return () => clearTimeout(t);
  }, [polling]);

  if (today.isPending) return <PageState current="today" kicker="Today" />;
  if (today.isError && !today.data) return <PageState current="today" kicker="Today" error={today.error.message} onRetry={() => void today.refetch()} />;
  if (!today.data) return <EmptyToday polling={polling} onPoll={() => setPolling(true)} />;
  return <LetterPager letter={today.data} today />;
}
