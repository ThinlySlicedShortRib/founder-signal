import { useLocalSearchParams } from "expo-router";
import { LetterPager } from "@/components/letter/LetterPager";
import { PageState } from "@/components/pager/PagerScreen";
import { useLetter } from "@/lib/letters";

/** A past letter from the Library, in the same pages as Today. */
export default function PastLetter() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const letter = useLetter(id);
  if (letter.isPending) return <PageState current="library" kicker="Letter" />;
  if (!letter.data) return <PageState current="library" kicker="Letter" error={letter.error?.message ?? "Letter not found"} onRetry={() => void letter.refetch()} />;
  return <LetterPager letter={letter.data} today={false} />;
}
