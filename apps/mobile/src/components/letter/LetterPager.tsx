import type { AuthorCard, LetterPiece, LetterView } from "@fs/schema";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { palette } from "@/components/onboarding/kit";
import { MenuSheet } from "@/components/pager/MenuSheet";
import { MenuToggle, Pill, PillButton, PillLabel } from "@/components/pager/Pill";
import { lastPage, letterWithLocal, setPieceState, track, useLocalVersion } from "@/lib/letters";
import { AuthorSheet } from "./Author";
import { CoverPage } from "./CoverPage";
import { PiecePage } from "./PiecePage";
import { PsPage } from "./PsPage";
import { Reader, type ReaderMeta, type UpNext } from "./Reader";

/** Where to open a letter with no saved position: the first piece not yet dealt with, or the cover. */
function startPage(l: LetterView): number {
  const touched = l.pieces.some((p) => p.completed || p.skipped || p.verdict);
  if (!touched) return 0;
  const open = l.pieces.find((p) => !p.completed && !p.skipped && !p.verdict);
  return open ? open.position : l.pieces.length + 1;
}

export function pieceMeta(p: LetterPiece, letter: Pick<LetterView, "id" | "pieces">): ReaderMeta {
  return {
    itemId: p.itemId,
    letterId: letter.id,
    kind: p.kind,
    title: p.title,
    topic: p.topic,
    minutes: p.minutes,
    image: p.image,
    author: p.author,
    whyPicked: p.whyPicked,
    sourceName: p.sourceName,
    originalUrl: p.originalUrl,
    position: p.position,
    pieceCount: letter.pieces.length,
    saved: p.saved,
    verdict: p.verdict,
    completed: p.completed,
  };
}

/**
 * A letter as full-screen pages: cover → one page per piece → P.S. The pill's
 * ↑ and ↓ move between pages (swiping up means "read", so it doesn't page).
 */
export function LetterPager({ letter: base, today }: { letter: LetterView; today: boolean }) {
  useLocalVersion();
  const letter = letterWithLocal(base);
  const n = letter.pieces.length;
  const pageCount = n + 2;
  const [page, setPage] = useState<number | null>(null);
  const [mode, setMode] = useState<"page" | "read">("page");
  const [menuOpen, setMenuOpen] = useState(false);
  const [author, setAuthor] = useState<AuthorCard | null>(null);

  // Open where the user left off: the saved page, else the first piece still to read.
  useEffect(() => {
    let live = true;
    void lastPage.get(base.id).then((saved) => {
      if (!live) return;
      setPage(saved !== null && saved >= 0 && saved < pageCount ? saved : startPage(base));
    });
    return () => {
      live = false;
    };
    // Only when the letter changes, not on every refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base.id]);

  const goPage = useCallback(
    (to: number) => {
      const p = Math.max(0, Math.min(pageCount - 1, to));
      setPage(p);
      setMode("page");
      lastPage.set(base.id, p);
    },
    [base.id, pageCount],
  );

  if (page === null) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: palette.ground }}>
        <ActivityIndicator color={palette.muted} accessibilityLabel="Opening your letter" />
      </View>
    );
  }

  const piece = page >= 1 && page <= n ? letter.pieces[page - 1]! : null;
  const isPs = page === n + 1;

  function skip(p: LetterPiece) {
    setPieceState(p.itemId, { skipped: true });
    track("skip", p.itemId, letter.id);
    goPage(p.position + 1);
  }

  function upNext(p: LetterPiece): UpNext {
    const following = letter.pieces[p.position];
    return following
      ? { kicker: `Up next · Piece ${following.position} of ${n}`, title: following.title, short: `Piece ${following.position}`, onPress: () => goPage(following.position) }
      : { kicker: "Up next · last page", title: "P.S. and tomorrow's letter", short: "P.S.", onPress: () => goPage(n + 1) };
  }

  const kicker = isPs ? "Postscript" : today ? "Today" : `No. ${letter.number}`;

  return (
    <View style={{ flex: 1, backgroundColor: palette.ground }}>
      <StatusBar style={page === 0 ? "dark" : "light"} />
      <Animated.View key={`${page}-${mode}`} entering={FadeIn.duration(220)} style={{ flex: 1 }}>
        {page === 0 ? (
          <CoverPage letter={letter} pageCount={pageCount} onPiece={goPage} />
        ) : piece && mode === "page" ? (
          <PiecePage
            piece={piece}
            letterNumber={letter.number}
            pieceCount={n}
            page={page}
            pageCount={pageCount}
            onRead={() => setMode("read")}
            onSkip={() => skip(piece)}
            onAuthor={() => piece.author && setAuthor(piece.author)}
          />
        ) : piece ? (
          <Reader
            meta={pieceMeta(piece, letter)}
            next={upNext(piece)}
            onBack={() => setMode("page")}
            onSkip={() => skip(piece)}
            onMenu={() => setMenuOpen(true)}
            onAuthor={() => piece.author && setAuthor(piece.author)}
          />
        ) : (
          <PsPage letter={letter} page={page} pageCount={pageCount} />
        )}
      </Animated.View>

      <MenuSheet open={menuOpen} onClose={() => setMenuOpen(false)} current={today ? "today" : null} />

      {mode === "page" ? (
        <Pill label="Navigation">
          <PillButton icon="up" label="Previous page" dim={page === 0} onPress={() => goPage(page - 1)} />
          <PillLabel kicker={kicker} value={`${page + 1} / ${pageCount}`} />
          <PillButton icon="down" label="Next page" dim={page === pageCount - 1} onPress={() => goPage(page + 1)} />
          <MenuToggle open={menuOpen} onPress={() => setMenuOpen((o) => !o)} />
        </Pill>
      ) : (
        menuOpen && (
          <Pill label="Navigation">
            <PillLabel kicker={kicker} value="Reading" />
            <MenuToggle open onPress={() => setMenuOpen(false)} />
          </Pill>
        )
      )}

      <AuthorSheet author={author} onClose={() => setAuthor(null)} />
    </View>
  );
}
