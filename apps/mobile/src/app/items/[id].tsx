import type { AuthorCard } from "@fs/schema";
import { router, useLocalSearchParams } from "expo-router";
import { useState } from "react";
import { View } from "react-native";
import { AuthorSheet } from "@/components/letter/Author";
import { pieceMeta } from "@/components/letter/LetterPager";
import { Reader, type ReaderMeta } from "@/components/letter/Reader";
import { palette } from "@/components/onboarding/kit";
import { MenuSheet } from "@/components/pager/MenuSheet";
import { MenuToggle, Pill, PillLabel, PillOutlet, PillProvider } from "@/components/pager/Pill";
import { PageState } from "@/components/pager/PagerScreen";
import { useItem, useSaved, useTodayLetter } from "@/lib/letters";
import { keepOnTouchElsewhere } from "@/lib/listen";

/** One piece on its own (from the Library or an author's "In your reading"), in the same reader. */
export default function ItemReader() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const today = useTodayLetter();
  const saved = useSaved();
  const item = useItem(id);
  const [menuOpen, setMenuOpen] = useState(false);
  const [author, setAuthor] = useState<AuthorCard | null>(null);

  const inLetter = today.data?.pieces.find((p) => p.itemId === id);
  const savedPiece = saved.data?.find((s) => s.itemId === id);
  let meta: ReaderMeta | null = null;
  if (inLetter && today.data) meta = pieceMeta(inLetter, today.data);
  else if (savedPiece || item.data) {
    meta = {
      itemId: id,
      letterId: null,
      kind: savedPiece?.kind ?? item.data!.kind,
      title: savedPiece?.title ?? item.data!.title,
      topic: savedPiece?.topic ?? null,
      minutes: savedPiece?.minutes ?? item.data?.minutes ?? null,
      image: savedPiece?.image ?? null,
      author: null,
      whyPicked: null,
      sourceName: savedPiece?.sourceName ?? item.data?.sourceName ?? null,
      originalUrl: item.data?.originalUrl ?? null,
      position: null,
      pieceCount: null,
      saved: !!savedPiece,
      verdict: null,
      completed: false,
    };
  }

  const back = () => (router.canGoBack() ? router.back() : router.replace("/library"));

  if (!meta) {
    if (item.isError) return <PageState current="library" kicker="Reading" error={item.error.message} onRetry={() => void item.refetch()} />;
    return <PageState current="library" kicker="Reading" />;
  }

  return (
    <PillProvider>
      <View style={{ flex: 1, backgroundColor: palette.surface }} onStartShouldSetResponderCapture={keepOnTouchElsewhere}>
        <Reader
          meta={meta}
          next={{ kicker: "Done", title: "Back to your library", short: "Library", onPress: back }}
          onBack={back}
          backLabel="Back"
          onMenu={() => setMenuOpen(true)}
          onAuthor={() => meta.author && setAuthor(meta.author)}
        />
        <MenuSheet open={menuOpen} onClose={() => setMenuOpen(false)} current={null} />
        {menuOpen && (
          <Pill label="Navigation" mode="menu">
            <PillLabel kicker="Library" value="Reading" />
            <MenuToggle open onPress={() => setMenuOpen(false)} />
          </Pill>
        )}
        {/* One pill for the Reader's modes and the menu's, so it morphs between them. */}
        <PillOutlet />
        <AuthorSheet author={author} onClose={() => setAuthor(null)} />
      </View>
    </PillProvider>
  );
}
