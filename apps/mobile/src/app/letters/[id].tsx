import { useLocalSearchParams } from "expo-router";
import { LetterPager } from "@/components/letter/LetterPager";
import { PageState } from "@/components/pager/PagerScreen";
import { useLetter } from "@/lib/letters";
import { listenParams } from "@/lib/now-playing-nav";

/** A past letter from the Library, in the same pages as Today. */
export default function PastLetter() {
  const { id, ...params } = useLocalSearchParams<{ id: string; page?: string; listen?: string }>();
  const focus = listenParams(params);
  const letter = useLetter(id);
  if (letter.isPending) return <PageState current="library" kicker="Letter" />;
  if (!letter.data) return <PageState current="library" kicker="Letter" error={letter.error?.message ?? "Letter not found"} onRetry={() => void letter.refetch()} />;
  return <LetterPager letter={letter.data} today={false} focus={focus} />;
}
