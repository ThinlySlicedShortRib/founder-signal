import type { AuthorCard, Block, DislikeReason, ItemView, LikeReason, PieceImage, ReviewVote, Section, SectionSummary } from "@fs/schema";
import { dislikeReasons, likeReasons } from "@fs/schema";
import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { StatusBar } from "expo-status-bar";
import { memo, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, Share, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Extrapolation,
  interpolate,
  type SharedValue,
  useAnimatedReaction,
  useAnimatedRef,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";
import { font, InlineError, palette } from "@/components/onboarding/kit";
import { PagerIcon, type PagerIconName, ProgressRing } from "@/components/pager/icons";
import { Pill, PillAction, PillButton, PillStatus, PillStatusSlot, PillStatusText, usePillSpace } from "@/components/pager/Pill";
import { AgentLine, Display, Mono } from "@/components/pager/PagerScreen";
import { Sheet } from "@/components/pager/Sheet";
import { timestamp } from "@/lib/format";
import { DISLIKE_LABELS, LIKE_LABELS, setPieceState, track, usePieceState, useItem, useSectionSummary, useToggleSave } from "@/lib/letters";
import { tasks as episodeTasks, useEpisodeTask, usePauseOnLeave } from "@/lib/listen";
import { useReview } from "@/lib/profile";
import { DRAWER_ROW, DrawerHeader, useArticleDrawer } from "./ArticleDrawer";
import { AuthorCardView, AuthorChip, SheetButton } from "./Author";
import { BlockView, TEXT_SIZES, type TextSize } from "./BlockRenderer";
import { EpisodeStatusRow } from "./EpisodeStatus";
import { FOCUS_STYLE_LABEL, FocusBlock, FocusProvider, nextFocusSetting, useFocusSetting, useFocusTracker } from "./Focus";
import { ListenCard } from "./Listen";
import { PhotoBackdrop, TINTS } from "./Photo";

/** What the reader knows about a piece before (or without) the item itself. */
export type ReaderMeta = {
  itemId: string;
  letterId: string | null;
  kind: "article" | "video";
  title: string;
  topic: string | null;
  minutes: number | null;
  image: PieceImage | null;
  author: AuthorCard | null;
  whyPicked: string | null;
  /** In a letter, the piece's summary: shown under the title and in the header's info. */
  summary?: string | null;
  sourceName: string | null;
  originalUrl: string | null;
  /** In a letter: "Piece 2 of 3". */
  position: number | null;
  pieceCount: number | null;
  saved: boolean;
  verdict: ReviewVote | null;
  completed: boolean;
};

export type UpNext = { kicker: string; title: string; short: string; onPress: () => void };

/** What a `lead` (the piece page under the article's drawer) is given. */
export type ReaderLead = {
  /** The screen's height; the lead is at least this tall. */
  height: number;
  /** How far the drawer is open, 0 → 1, on the UI thread. */
  progress: SharedValue<number>;
  /** Opens the drawer. */
  onRead: () => void;
  /** Opens the video on YouTube. */
  onPlay: () => void;
  /** Articles: starts making the piece's episode (the pill grows its status row); once there is one, goes to its Listen card. */
  onListen?: () => void;
  /** The piece's episode is on the go (the headphones button shows it). */
  listening?: boolean;
};

const HEAD_MAX = 200;
const HEAD_MIN = 72;
/** The header turns into the plain white bar once it's this short (the board's `≤ 96`). */
const COMPACT_AT = 96;
const PLAYER = 220;

type SummaryState = { status: "loading" } | { status: "error" } | { status: "done"; summary: SectionSummary };

/**
 * Reading in place (PagerReader / PagerVideo). Every action is in the pill;
 * at the end the pill asks for the verdict, then offers the next piece.
 *
 * On its own (the Library), a photo header shrinks with scrolling to a white
 * bar. In a letter, `lead` renders the piece page and the article sits in a
 * drawer over it (ArticleDrawer): out of sight until the piece page is
 * dragged up or Read is tapped, then snapped to the top. While the drawer is
 * down the reader stays out of the way (no pill, and `onReadingChange(false)`,
 * so the pager shows its own pill). Once it's up, the reading pill takes over
 * and `onReadingChange(true)`; closing it undoes that and keeps your place.
 */
export function Reader({
  meta,
  next,
  onBack,
  backLabel = "Back to the piece page",
  onSkip,
  onMenu,
  onAuthor,
  lead,
  onReadingChange,
}: {
  meta: ReaderMeta;
  next: UpNext;
  /** Leaving the reader. With a `lead`, back closes the drawer instead. */
  onBack?: () => void;
  backLabel?: string;
  onSkip?: () => void;
  onMenu: () => void;
  onAuthor: () => void;
  /** The piece page, under the article's drawer. */
  lead?: (l: ReaderLead) => ReactNode;
  onReadingChange?: (reading: boolean) => void;
}) {
  const insets = useSafeAreaInsets();
  const pill = usePillSpace();
  const reduceMotion = useReducedMotion();
  const item = useItem(meta.itemId);
  const state = usePieceState(meta.itemId, { saved: meta.saved, verdict: meta.verdict, completed: meta.completed });
  const toggleSave = useToggleSave();
  const review = useReview();
  const summarize = useSectionSummary(meta.itemId);
  const episode = useEpisodeTask(meta.itemId);
  // One player for the app: leaving the piece stops its audio; opening and closing the drawer doesn't.
  usePauseOnLeave(meta.itemId);

  const data = item.data;
  const kind = data?.kind ?? meta.kind;
  const video = kind === "video";
  const title = data?.title ?? meta.title;
  const minutes = data?.minutes ?? meta.minutes ?? 1;
  const originalUrl = data?.originalUrl ?? meta.originalUrl;
  const flow = !!lead;
  // In the drawer the header is one tight row under the status bar, and the article starts under it.
  const headMax = flow ? insets.top + DRAWER_ROW : (video ? PLAYER : HEAD_MAX) + insets.top;
  const headMin = flow ? headMax : HEAD_MIN + insets.top;
  const screenH = useWindowDimensions().height;
  const [viewport, setViewport] = useState(screenH);
  const drawer = useArticleDrawer({ screenH: viewport, reduceMotion });
  // For worklets: capture these, never the whole drawer (its gesture and styles don't cross threads).
  const { y: drawerY, close: closeDrawer } = drawer;
  /** Where the article's own title ends in the scroll, for the drawer header. */
  const titleBottom = useSharedValue(Number.MAX_SAFE_INTEGER);

  // ── Scroll position, progress, sections ────────────────────────────────────
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const scrollY = useSharedValue(0);
  const yRef = useRef(0);
  const viewH = useRef(0);
  const contentH = useRef(0);
  /** Where the article starts in the scroll: under the header. */
  const bodyTop = useRef(headMax);
  /** The offset at which the article is reached (its top just under the bar): always 0 now. */
  const startY = useSharedValue(0);
  /** Sections and the end card, measured within the article. */
  const sectionY = useRef(new Map<string, number>());
  const endY = useRef<number | null>(null);
  const [progress, setProgress] = useState(0);
  const [compact, setCompact] = useState(false);
  /** The same, on the UI thread, for the focus highlight. */
  const viewS = useSharedValue(0);
  const contentS = useSharedValue(0);
  const articleTop = useSharedValue(headMax);
  const [atEnd, setAtEnd] = useState(false);
  const [nextIsEnd, setNextIsEnd] = useState(false);

  const sectionTops = useCallback(() => [...sectionY.current.values()].map((v) => bodyTop.current + v), []);

  const recompute = useCallback(() => {
    const y = yRef.current;
    // Progress runs from the start of the article to the end of the scroll.
    const start = flow ? Math.max(0, bodyTop.current - headMin) : 0;
    const span = contentH.current - viewH.current - start;
    setProgress(span > 0 ? Math.round(Math.min(1, Math.max(0, (y - start) / span)) * 100) / 100 : y >= start ? 1 : 0);
    // With a lead, `compact` (reading) is decided on the UI thread below.
    if (!flow) setCompact(!video && headMax - insets.top - y <= COMPACT_AT);
    const end = endY.current;
    // The end card in view; until it's been measured, the board's rule (92% scrolled).
    setAtEnd(end !== null ? viewH.current > 0 && y + viewH.current >= bodyTop.current + end + 80 : span > 0 && (y - start) / span > 0.92);
    const targets = sectionTops().filter((v) => v > y + headMin + 8);
    setNextIsEnd(targets.length === 0);
  }, [flow, video, headMax, headMin, insets.top, sectionTops]);

  const onTick = useCallback(
    (y: number, view: number, content: number) => {
      yRef.current = y;
      // A scroll counts as Keep for an open "Stop this episode?".
      if (episodeTasks.anyConfirm()) episodeTasks.dismiss({ scroll: true });
      if (view > 0) viewH.current = view;
      if (content > 0) contentH.current = content;
      recompute();
    },
    [recompute],
  );

  // Progress, the compact bar and the end are worked out on the JS side every 6px of scrolling.
  const lastTick = useSharedValue(-100);
  const onScroll = useAnimatedScrollHandler({
    onScroll: (e) => {
      const y = e.contentOffset.y;
      scrollY.set(y);
      viewS.set(e.layoutMeasurement.height);
      contentS.set(e.contentSize.height);
      if (Math.abs(y - lastTick.get()) >= 6) {
        lastTick.set(y);
        scheduleOnRN(onTick, y, e.layoutMeasurement.height, e.contentSize.height);
      }
    },
    // In the drawer, pulling well past the top of the article (iOS bounce) closes it.
    onEndDrag: (e) => {
      if (flow && e.contentOffset.y < -56) closeDrawer();
    },
  });

  // With a lead: reading while the drawer is all the way up. Decided on the UI thread;
  // React hears about it when it flips.
  const reading = useSharedValue(0);
  useAnimatedReaction(
    () => flow && drawerY.get() < 0.5,
    (now, before) => {
      if (now === before) return;
      reading.set(now ? 1 : 0);
      scheduleOnRN(setCompact, now);
    },
  );
  useEffect(() => {
    if (flow) onReadingChange?.(compact);
  }, [flow, compact, onReadingChange]);

  // ── Focus highlight: the block at the reading line in full ink ─────────────
  const [focusSetting, setFocusSetting] = useFocusSetting();
  const articleRef = useRef<View>(null);
  useEffect(() => {
    articleTop.set(headMax);
    bodyTop.current = headMax;
  }, [headMax, articleTop]);
  const focus = useFocusTracker({
    articleRef,
    setting: focusSetting,
    reduceMotion,
    scrollY,
    viewH: viewS,
    contentH: contentS,
    articleTop,
    startY,
    reading,
    flow,
    headMin,
    headMax,
  });

  // ── Events ─────────────────────────────────────────────────────────────────
  // `open` once the article is reached (scrolled to, or Read tapped); at once without a lead.
  const opened = useRef(false);
  const markOpen = useCallback(() => {
    if (opened.current) return;
    opened.current = true;
    track("open", meta.itemId, meta.letterId);
  }, [meta.itemId, meta.letterId]);
  useEffect(() => {
    if (!flow || compact) markOpen();
  }, [flow, compact, markOpen]);

  const completed = useRef(meta.completed);
  useEffect(() => {
    if (!atEnd || completed.current || !data || (flow && !compact)) return;
    completed.current = true;
    setPieceState(meta.itemId, { completed: true });
    track("complete", meta.itemId, meta.letterId);
  }, [atEnd, data, flow, compact, meta.itemId, meta.letterId]);

  // ── Tray, text size, summaries, verdict ────────────────────────────────────
  const [tray, setTrayOpen] = useState(false);
  /** The section in view when the tray opened, for "Summarize this section". */
  const [inViewId, setInViewId] = useState<string | null>(null);
  const [size, setSize] = useState<TextSize>("standard");
  const [shareNote, setShareNote] = useState("");
  const [summaries, setSummaries] = useState<Record<string, SummaryState>>({});
  const [sheet, setSheet] = useState<"yes" | "no" | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [reviewError, setReviewError] = useState(false);

  const sections = useMemo(() => sectionsOf(data), [data]);
  const onSectionLayout = useCallback(
    (id: string, y: number) => {
      sectionY.current.set(id, y);
      recompute();
    },
    [recompute],
  );

  function sectionInView(): Section | undefined {
    let found = sections[0];
    for (const s of sections) {
      const y = sectionY.current.get(s.id);
      if (y !== undefined && bodyTop.current + y <= yRef.current + headMin + 48) found = s;
    }
    return found;
  }

  function scrollToY(y: number) {
    scrollRef.current?.scrollTo({ y: Math.max(0, y), animated: !reduceMotion });
  }

  function nextSection() {
    const targets = sectionTops().filter((v) => v > yRef.current + headMin + 8).sort((a, b) => a - b);
    const target = targets[0] ?? (endY.current !== null ? bodyTop.current + endY.current : null);
    if (target !== null) scrollToY(target - headMin - 12);
  }

  /** Where the Listen card is within the article, and a counter that rings it once. */
  const listenY = useRef<number | null>(null);
  const [listenFlash, setListenFlash] = useState(0);
  /** The pill's status row was tapped: open the drawer if it's down, and bring the Listen card into view. */
  function goToListen() {
    if (flow && !compact) {
      markOpen();
      drawer.open();
    }
    if (listenY.current !== null) scrollToY(bodyTop.current + listenY.current - headMin - 16);
    setListenFlash((n) => n + 1);
  }

  /** Read on the piece page: up comes the drawer. */
  function read() {
    markOpen();
    drawer.open();
  }

  /** Back: the drawer goes down (keeping your place), or out of the reader. */
  function back() {
    if (flow) drawer.close();
    else if (!onBack) scrollToY(0);
    else onBack();
  }

  async function share() {
    setTray(false);
    if (!originalUrl) return;
    try {
      await Share.share({ message: `${title}\n${originalUrl}`, url: originalUrl, title });
    } catch {
      await Clipboard.setStringAsync(originalUrl);
      setShareNote("Link copied");
      setTray(true);
    }
  }

  function toggleSummary() {
    setTray(false);
    const s = sectionInView();
    if (!s) return;
    if (summaries[s.id]) {
      setSummaries(({ [s.id]: _, ...rest }) => rest);
      return;
    }
    setSummaries((m) => ({ ...m, [s.id]: { status: "loading" } }));
    track("summary_expand", meta.itemId, meta.letterId);
    summarize.mutate(s.id, {
      onSuccess: (summary) => setSummaries((m) => ({ ...m, [s.id]: { status: "done", summary } })),
      onError: () => setSummaries((m) => ({ ...m, [s.id]: { status: "error" } })),
    });
  }

  const retrySummary = useRef(toggleSummary);
  useEffect(() => {
    retrySummary.current = toggleSummary;
  });
  const onRetrySummary = useCallback(() => retrySummary.current(), []);

  function finishVerdict() {
    if (!sheet) return;
    const vote: ReviewVote = sheet === "yes" ? "interested" : "not_interested";
    const allowed = (sheet === "yes" ? likeReasons : dislikeReasons) as readonly string[];
    const reasons = picked.filter((r) => allowed.includes(r)) as (LikeReason | DislikeReason)[];
    const before = state.verdict ?? null;
    setSheet(null);
    setReviewError(false);
    setPieceState(meta.itemId, { verdict: vote });
    review.mutate(
      { itemId: meta.itemId, vote, reasons, origin: "in_app" },
      {
        onError: () => {
          setPieceState(meta.itemId, { verdict: before });
          setReviewError(true);
        },
      },
    );
  }

  function setTray(open: boolean | ((was: boolean) => boolean)) {
    const next = typeof open === "function" ? open(tray) : open;
    if (next) setInViewId(sectionInView()?.id ?? null);
    setTrayOpen(next);
  }
  const canSummarize = !!data?.blocks?.length && sections.length > 0;
  const left = Math.max(0, Math.round(minutes * (1 - progress)));
  const showEndPill = atEnd && !state.verdict && !sheet;
  const showNextPill = atEnd && !!state.verdict && !sheet;
  /** With a lead, the reading pill and tray only once the article is reached; the pager's pill before. */
  const pillOn = !flow || compact;

  // ── Header styles ──────────────────────────────────────────────────────────
  const headStyle = useAnimatedStyle(() => ({ height: video ? headMax : Math.max(headMin, headMax - Math.max(0, scrollY.get())) }));
  const collapseAt = HEAD_MAX - COMPACT_AT;
  const photoStyle = useAnimatedStyle(() => ({ opacity: interpolate(scrollY.get(), [collapseAt - 8, collapseAt], [1, 0], Extrapolation.CLAMP) }));
  const barStyle = useAnimatedStyle(() => ({ opacity: interpolate(scrollY.get(), [collapseAt - 8, collapseAt], [0, 1], Extrapolation.CLAMP) }));
  const kicker = [meta.position && meta.pieceCount ? `Piece ${meta.position} of ${meta.pieceCount}` : null, meta.topic].filter(Boolean).join(" · ");
  const sourceRights = video ? (data?.video?.chapters?.length ? "transcript" : "video") : data?.blocks ? "full text" : data?.digest ? "digest" : null;
  const digestMode = !video && !!data && !data.blocks && !!data.digest;

  function openVideo(at = 0) {
    const id = data?.video?.youtubeId;
    const url = id ? `https://www.youtube.com/watch?v=${id}${at ? `&t=${at}s` : ""}` : originalUrl;
    if (url) void Linking.openURL(url);
  }

  function onPlay() {
    markOpen();
    openVideo(0);
  }

  const scroll = (
    <Animated.ScrollView
      ref={scrollRef}
      onScroll={onScroll}
      scrollEventThrottle={16}
      onLayout={(e) => {
        viewH.current = e.nativeEvent.layout.height;
        viewS.set(viewH.current);
        if (viewH.current > 0) setViewport(viewH.current);
        recompute();
      }}
      onContentSizeChange={(_w, h) => {
        contentH.current = h;
        contentS.set(h);
        recompute();
      }}
      contentContainerStyle={{ paddingTop: headMax }}
    >
      {/* The article. In the drawer it's at least a screen tall. */}
      <FocusProvider value={focus}>
        <View
          ref={articleRef}
          collapsable={false}
          onLayout={focus.changed}
          style={{ backgroundColor: palette.surface, paddingTop: 18, paddingHorizontal: 20, paddingBottom: pill.space + 16, gap: 18, minHeight: flow ? viewport - headMin : undefined }}
        >
          {/* In the drawer, the article's own header: the drawer's header takes the title over once this one has scrolled under it. */}
          {flow && (
            <>
              <Text
                accessibilityRole="header"
                onLayout={(e) => titleBottom.set(e.nativeEvent.layout.y + e.nativeEvent.layout.height)}
                style={{ fontFamily: font.display, fontSize: 26, lineHeight: 28, letterSpacing: -0.65, color: palette.ink }}
              >
                {title}
              </Text>
              {!!meta.summary && <Text style={{ marginTop: -6, fontFamily: font.body, fontSize: 16, lineHeight: 23.2, color: palette.promptInk }}>{meta.summary}</Text>}
              {meta.author && <AuthorChip author={meta.author} onPress={onAuthor} />}
            </>
          )}
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, borderBottomWidth: 1, borderBottomColor: palette.rule, paddingBottom: 12 }}>
            <Text style={{ flex: 1, fontFamily: font.body, fontSize: 14, lineHeight: 19, color: palette.muted }}>
              {[meta.sourceName ?? data?.sourceName, `${minutes} min`, sourceRights].filter(Boolean).join(" · ")}
            </Text>
            {originalUrl && (
              <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(originalUrl)} style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Text style={{ fontFamily: font.bodySemi, fontSize: 14, color: palette.blue }}>{video ? "YouTube" : "Original"}</Text>
                <PagerIcon name="external" size={15} color={palette.blue} />
              </Pressable>
            )}
          </View>
          {!video && (
            <View onLayout={(e) => (listenY.current = e.nativeEvent.layout.y)}>
              <ListenCard itemId={meta.itemId} flash={listenFlash} />
            </View>
          )}
          {/* The photo's credit, under the standalone reader's photo header; a piece page in a letter shows its art instead. */}
          {!flow && meta.image?.credit && (
            <Pressable accessibilityRole="link" disabled={!meta.image.creditUrl} onPress={() => meta.image?.creditUrl && void Linking.openURL(meta.image.creditUrl)} style={{ marginTop: -10 }}>
              <Text style={{ fontFamily: font.body, fontSize: 12.5, color: palette.offText }}>
                {meta.image.source === "stock" ? "Stock photo" : "Photo"}: {meta.image.credit}
              </Text>
            </Pressable>
          )}
          {/* In the drawer the author is above, and the piece page has already said why it was picked. */}
          {!flow && meta.author && <AuthorChip author={meta.author} onPress={onAuthor} />}
          {!flow && meta.whyPicked && (
            <AgentLine>
              <Text style={{ fontFamily: font.bodySemi }}>Why I picked this. </Text>
              {meta.whyPicked}
            </AgentLine>
          )}

          {item.isPending ? (
            <ActivityIndicator color={palette.muted} style={{ marginVertical: 40 }} accessibilityLabel="Loading the piece" />
          ) : item.isError ? (
            <InlineError message={item.error.message} onRetry={() => void item.refetch()} />
          ) : video ? (
            <Chapters item={data!} onOpen={openVideo} />
          ) : data?.blocks ? (
            <ArticleBlocks blocks={data.blocks} sections={sections} size={size} summaries={summaries} onSectionLayout={onSectionLayout} onRetry={onRetrySummary} />
          ) : digestMode ? (
            <>
              <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", minHeight: 48, borderTopWidth: 1, borderBottomWidth: 1, borderColor: palette.rule }}>
                <DigestBadge />
                {originalUrl && (
                  <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(originalUrl)} style={{ minHeight: 44, justifyContent: "center" }}>
                    <Text style={{ fontFamily: font.bodySemi, fontSize: 14, color: palette.blue }}>Read the original ↗</Text>
                  </Pressable>
                )}
              </View>
              <DigestText text={data!.digest!} size={size} />
            </>
          ) : (
            <Unavailable reason={data?.unavailableReason ?? null} onOpen={originalUrl ? () => void Linking.openURL(originalUrl) : undefined} />
          )}

          {/* About the author, in full, once the piece is read. */}
          {meta.author && (
            <View style={{ gap: 10, marginTop: 6 }}>
              <Mono>About the author</Mono>
              <AuthorCardView author={meta.author} onMore={onAuthor} />
            </View>
          )}

          {/* The end card (.endc) */}
          <View
            onLayout={(e) => {
              endY.current = e.nativeEvent.layout.y;
              recompute();
            }}
            style={{ gap: 12, borderRadius: 24, padding: 20, backgroundColor: TINTS[((meta.position ?? 1) - 1) % 3] }}
          >
            <Mono color={palette.promptInk}>
              Finished · {minutes} min{digestMode ? " · digest" : ""}
            </Mono>
            <Text style={{ fontFamily: font.display, fontSize: 28, lineHeight: 29.4, letterSpacing: -0.7, color: palette.ink }}>
              {video ? "That's the video." : "That's the piece."}
            </Text>
            <Text style={{ fontFamily: font.body, fontSize: 15, color: palette.promptInk }}>
              {state.verdict === "interested" ? "Worth it. Noted." : state.verdict === "not_interested" ? "Less like this. Noted." : "Use the pill: was it worth your time?"}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${next.kicker}: ${next.title}`}
              onPress={next.onPress}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
                minHeight: 64,
                borderRadius: 18,
                backgroundColor: palette.ink,
                paddingHorizontal: 18,
                paddingVertical: 10,
                opacity: pressed ? 0.88 : 1,
              })}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <Mono color={palette.pillMuted}>{next.kicker}</Mono>
                <Text style={{ fontFamily: font.bodySemi, fontSize: 16, color: "#FFFFFF" }}>{next.title}</Text>
              </View>
              <PagerIcon name="down" color="#FFFFFF" />
            </Pressable>
          </View>
        </View>
      </FocusProvider>
    </Animated.ScrollView>
  );

  return (
    <View style={{ flex: 1, backgroundColor: flow ? "#000000" : palette.surface }}>
      {/* In a letter the pager sets the status bar (dark on a piece page, which is light now). */}
      {!flow && <StatusBar style={compact ? "dark" : "light"} />}
      {lead ? (
        <>
          {/* The piece page, behind: drag up anywhere on it for the drawer. It shrinks back and dims as the drawer comes. */}
          <GestureDetector gesture={drawer.coverPan}>
            <Animated.View
              accessibilityElementsHidden={compact}
              importantForAccessibility={compact ? "no-hide-descendants" : "auto"}
              style={[StyleSheet.absoluteFill, { transformOrigin: "top" }, drawer.coverStyle]}
            >
              {lead({
                height: viewport,
                progress: drawer.openness,
                onRead: read,
                onPlay,
                onListen:
                  video || !episode.available
                    ? undefined
                    : () => {
                        if (episode.phase === "idle") episode.start();
                        else goToListen();
                      },
                listening: episode.phase !== "idle" && episode.phase !== "stopped",
              })}
            </Animated.View>
          </GestureDetector>
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: "#000000", pointerEvents: "none" }, drawer.dimStyle]} />
          {/* The drawer: the article, under its sticky header. */}
          <Animated.View
            accessibilityElementsHidden={!compact}
            importantForAccessibility={compact ? "auto" : "no-hide-descendants"}
            style={[StyleSheet.absoluteFill, { overflow: "hidden", backgroundColor: palette.surface, boxShadow: "0 -10px 30px rgba(0,0,0,0.28)" }, drawer.drawerStyle]}
          >
            {scroll}
            <DrawerHeader
              drawer={drawer}
              scrollY={scrollY}
              titleBottom={titleBottom}
              insetTop={insets.top}
              title={title}
              summary={meta.summary ?? null}
              author={meta.author}
              onAuthor={onAuthor}
              onClose={back}
              reduceMotion={reduceMotion}
            />
          </Animated.View>
        </>
      ) : (
        <>
          {scroll}
          {/* Header: the photo, shrinking to the plain white bar (.rhead / .rhead.compact), or the video still (.player). */}
          <Animated.View style={[{ position: "absolute", top: 0, left: 0, right: 0, overflow: "hidden", zIndex: 5 }, headStyle]}>
            {video ? (
              <View style={[StyleSheet.absoluteFill, { backgroundColor: palette.ink }]}>
                {meta.image && <Image source={{ uri: meta.image.url }} style={[StyleSheet.absoluteFill, { opacity: 0.55 }]} contentFit="cover" />}
                <RoundButton icon="chevron-down" label={backLabel} onPress={back} style={{ top: insets.top + 18, left: 14 }} />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Play on YouTube"
                  onPress={() => openVideo(0)}
                  style={{ position: "absolute", left: "50%", top: insets.top + PLAYER / 2, marginLeft: -38, marginTop: -38, width: 76, height: 76, borderRadius: 38, backgroundColor: "rgba(255,255,255,0.92)", alignItems: "center", justifyContent: "center" }}
                >
                  <PagerIcon name="play" size={30} color={palette.ink} />
                </Pressable>
                <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 14, paddingBottom: 10, gap: 6 }}>
                  <Mono color="#FFFFFF" numberOfLines={1}>
                    {data?.video?.durationSeconds ? `${timestamp(data.video.durationSeconds)} · ` : ""}
                    {title}
                  </Mono>
                  <View style={{ height: 3, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.3)" }} />
                </View>
              </View>
            ) : (
              <>
                <Animated.View style={[StyleSheet.absoluteFill, { pointerEvents: compact ? "none" : "box-none" }, photoStyle]}>
                  <PhotoBackdrop image={meta.image} topic={meta.topic ?? title} variant="head" blurHeight="78%" />
                  <RoundButton icon="chevron-down" label={backLabel} onPress={back} style={{ top: insets.top + 18, left: 14 }} />
                  <View style={{ position: "absolute", left: 0, right: 0, bottom: 0, paddingHorizontal: 20, paddingBottom: 16, gap: 8 }}>
                    {!!kicker && <Mono color="rgba(255,255,255,0.85)">{kicker}</Mono>}
                    <Text accessibilityRole="header" numberOfLines={3} style={{ fontFamily: font.display, fontSize: 26, lineHeight: 28, letterSpacing: -0.65, color: "#FFFFFF" }}>
                      {title}
                    </Text>
                  </View>
                </Animated.View>
                <Animated.View
                  style={[StyleSheet.absoluteFill, { backgroundColor: palette.surface, borderBottomWidth: 1, borderBottomColor: palette.rule, pointerEvents: compact ? "box-none" : "none" }, barStyle]}
                >
                  <CompactBar title={title} digest={digestMode} backLabel={backLabel} onBack={back} />
                </Animated.View>
              </>
            )}
          </Animated.View>
        </>
      )}

      {/* The tray (.tray) */}
      {tray && pillOn && (
        <>
          <Pressable accessibilityLabel="Close the menu" onPress={() => setTray(false)} style={[StyleSheet.absoluteFill, { zIndex: 19 }]} />
          <View
            accessibilityRole="menu"
            accessibilityLabel="More"
            style={{
              position: "absolute",
              bottom: pill.bottom + 66 + pill.statusH,
              alignSelf: "center",
              width: 290,
              zIndex: 21,
              backgroundColor: palette.pill,
              borderRadius: 22,
              padding: 6,
              boxShadow: "0 12px 30px rgba(18,19,22,0.25)",
            }}
          >
            {originalUrl && <TrayItem icon="share" title="Share" note={shareNote} onPress={share} />}
            {canSummarize && <TrayItem icon="doc" title={inViewId && summaries[inViewId] ? "Hide the summary" : "Summarize this section"} onPress={toggleSummary} />}
            {originalUrl && (
              <TrayItem
                icon="external"
                title="Open original"
                onPress={() => {
                  setTray(false);
                  void Linking.openURL(originalUrl);
                }}
              />
            )}
            {!video && (
              <TrayItem
                glyph="Aa"
                title="Text size"
                note={size === "large" ? "Large" : "Standard"}
                onPress={() => setSize((s) => (s === "large" ? "standard" : "large"))}
              />
            )}
            {!video && (
              <TrayItem
                glyph="¶"
                title="Focus highlight"
                note={focusSetting.on ? FOCUS_STYLE_LABEL[focusSetting.style] : "Off"}
                onPress={() => setFocusSetting(nextFocusSetting(focusSetting))}
              />
            )}
            <View style={{ height: 1, backgroundColor: "rgba(255,255,255,0.1)", marginVertical: 4, marginHorizontal: 8 }} />
            {onSkip && (
              <TrayItem
                icon="close"
                title="Skip this one"
                onPress={() => {
                  setTray(false);
                  onSkip();
                }}
              />
            )}
            <TrayItem
              icon="chevron-down"
              title={backLabel}
              onPress={() => {
                setTray(false);
                back();
              }}
            />
            <TrayItem
              icon="menu"
              title="Menu"
              onPress={() => {
                setTray(false);
                onMenu();
              }}
            />
          </View>
        </>
      )}

      {/* The episode's status row, above whichever controls the pill has (the pager's on the cover, these once reading). */}
      <PillStatusSlot>{!video && episode.row ? <EpisodeStatusRow itemId={meta.itemId} onOpen={goToListen} /> : null}</PillStatusSlot>

      {/* The pill: reading → verdict → next (under a lead, only once reading). One <Pill> in one place, so it morphs
          between modes; in a letter it's drawn by the pager's PillOutlet. It fades out under the verdict sheet. */}
      {!pillOn ? null : showNextPill ? (
        <Pill label="Next" mode="next" hidden={!!sheet}>
          <PillStatus label={state.verdict === "interested" ? "Worth it. Noted." : "Less like this."}>
            <PagerIcon name="check" size={18} color={palette.blueMid} />
            <PillStatusText>{state.verdict === "interested" ? "Worth it. Noted." : "Less like this."}</PillStatusText>
          </PillStatus>
          <PillAction title={`${next.short} ↓`} label={`${next.kicker}: ${next.title}`} onPress={next.onPress} primary />
        </Pill>
      ) : showEndPill ? (
        <Pill label="Was it worth it?" mode="verdict" hidden={!!sheet}>
          <PillAction
            title="Not for me"
            onPress={() => {
              setPicked([]);
              setSheet("no");
            }}
          />
          <PillAction
            title="Worth it"
            primary
            onPress={() => {
              setPicked([]);
              setSheet("yes");
            }}
          />
          <PillButton icon="dots" label="More" onPress={() => setTray((t) => !t)} expanded={tray} />
        </Pill>
      ) : (
        <Pill label="Reading" mode="reading" hidden={!!sheet}>
          <PillButton
            icon="bookmark"
            filled={!!state.saved}
            pressed={!!state.saved}
            label={state.saved ? "Saved to Library" : "Save to Library"}
            onPress={() => toggleSave(meta.itemId, meta.letterId, !state.saved)}
          />
          <PillStatus label={left === 0 ? "Almost done" : `${left} ${left === 1 ? "minute" : "minutes"} left`}>
            <ProgressRing progress={progress} />
            <PillStatusText>{left === 0 ? "Almost done" : `${left} min left`}</PillStatusText>
          </PillStatus>
          <PillButton icon="down" label={nextIsEnd ? "Jump to the end" : "Next section"} onPress={nextSection} />
          <PillButton icon="dots" label="More" onPress={() => setTray((t) => !t)} blue expanded={tray} />
        </Pill>
      )}
      {reviewError && (
        <View style={{ pointerEvents: "none", position: "absolute", left: 20, right: 20, bottom: pill.bottom + 62 + pill.statusH, zIndex: 18 }}>
          <InlineError message="Couldn't save your verdict. Try again." />
        </View>
      )}

      <Sheet open={!!sheet} onClose={finishVerdict} label={sheet === "no" ? "What wasn't right?" : "What did you like about it?"} radius={24} grab={false} style={{ paddingTop: 20, gap: 12 }}>
        <Mono>Pick any</Mono>
        <Display size={30} lineHeight={32}>
          {sheet === "no" ? "What wasn't right?" : "What did you like about it?"}
        </Display>
        {(sheet === "no" ? (Object.entries(DISLIKE_LABELS) as [string, string][]) : (Object.entries(LIKE_LABELS) as [string, string][])).map(([value, label]) => {
          const on = picked.includes(value);
          return (
            <Pressable
              key={value}
              accessibilityRole="checkbox"
              aria-checked={on}
              onPress={() => setPicked((p) => (on ? p.filter((x) => x !== value) : [...p, value]))}
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                minHeight: 56,
                borderRadius: 16,
                borderWidth: 1.5,
                borderColor: on ? palette.blue : palette.lineSoft,
                backgroundColor: on ? palette.blueCard : palette.surface,
                paddingHorizontal: 16,
              }}
            >
              <Text style={{ fontFamily: font.bodySemi, fontSize: 16, color: on ? palette.blueInk : palette.ink }}>{label}</Text>
              <View
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 7,
                  borderWidth: 1.5,
                  borderColor: on ? palette.blue : palette.boxLine,
                  backgroundColor: on ? palette.blue : palette.surface,
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {on && <PagerIcon name="check" size={14} strokeWidth={3} color="#FFFFFF" />}
              </View>
            </Pressable>
          );
        })}
        <View style={{ flexDirection: "row" }}>
          <SheetButton title="Done" primary onPress={finishVerdict} />
        </View>
      </Sheet>
    </View>
  );
}

/** The item's sections, or one section covering everything when it has none. */
function sectionsOf(item: ItemView | undefined): Section[] {
  const n = item?.blocks?.length ?? 0;
  if (!n) return [];
  const given = [...(item?.sections ?? [])].filter((s) => s.endBlock > s.startBlock).sort((a, b) => a.startBlock - b.startBlock);
  if (!given.length) return [{ id: "all", title: null, startBlock: 0, endBlock: n }];
  // Blocks before the first section or after the last still get shown.
  const out: Section[] = [];
  if (given[0]!.startBlock > 0) out.push({ id: "_lead", title: null, startBlock: 0, endBlock: given[0]!.startBlock });
  out.push(...given);
  const last = given[given.length - 1]!;
  if (last.endBlock < n) out.push({ id: "_tail", title: null, startBlock: last.endBlock, endBlock: n });
  return out;
}

/**
 * The article's blocks, by section. Memoised: the reader re-renders as progress ticks over, the
 * article doesn't (focus is animated inside each block, never rendered).
 */
const ArticleBlocks = memo(function ArticleBlocks({
  blocks,
  sections,
  size,
  summaries,
  onSectionLayout,
  onRetry,
}: {
  blocks: Block[];
  sections: Section[];
  size: TextSize;
  summaries: Record<string, SummaryState>;
  onSectionLayout: (id: string, y: number) => void;
  onRetry: () => void;
}) {
  return sections.map((s) => {
    const headed = blocks[s.startBlock]?.type === "heading";
    const sum = summaries[s.id];
    const rest: number[] = [];
    for (let i = s.startBlock + (headed ? 1 : 0); i < s.endBlock; i++) rest.push(i);
    return (
      <View key={s.id} style={{ gap: 18 }} onLayout={(e) => onSectionLayout(s.id, e.nativeEvent.layout.y)}>
        {headed && <BlockView block={blocks[s.startBlock]!} size={size} />}
        {sum && <SummaryCard state={sum} onRetry={onRetry} />}
        {rest.map((i) => {
          const b = blocks[i]!;
          // Headings stay in full ink and aren't focused; a list's items are focused one by one;
          // everything else is a focusable block.
          if (b.type === "heading") return <BlockView key={i} block={b} size={size} />;
          if (b.type === "list") {
            return (
              <BlockView
                key={i}
                block={b}
                size={size}
                wrapItem={(j, row) => (
                  <FocusBlock key={j} index={listItemIndex(i, j)}>
                    {row}
                  </FocusBlock>
                )}
              />
            );
          }
          return (
            <FocusBlock key={i} index={i} media={b.type === "image" || b.type === "table"}>
              <BlockView block={b} size={size} />
            </FocusBlock>
          );
        })}
      </View>
    );
  });
});

/** A focus index for a list's item, clear of the block indexes. */
const listItemIndex = (block: number, item: number) => 1_000_000 + block * 1_000 + item;

/** A digest's paragraphs, each focusable like the article's. */
const DigestText = memo(function DigestText({ text, size }: { text: string; size: TextSize }) {
  const style = { fontFamily: font.body, color: palette.ink, ...TEXT_SIZES[size] };
  return text
    .split(/\n{2,}/)
    .filter(Boolean)
    .map((p, i) => (
      <FocusBlock key={i} index={i}>
        <Text style={style}>{p}</Text>
      </FocusBlock>
    ));
});

function Chapters({ item, onOpen }: { item: ItemView; onOpen: (at: number) => void }) {
  const chapters = item.video?.chapters;
  if (!chapters?.length) {
    return (
      <View style={{ gap: 12 }}>
        <Text style={{ fontFamily: font.body, fontSize: 16, lineHeight: 24, color: palette.promptInk }}>There&apos;s no transcript for this video yet, so it&apos;s best watched on YouTube.</Text>
        <View style={{ flexDirection: "row" }}>
          <SheetButton title="Watch on YouTube" icon onPress={() => onOpen(0)} />
        </View>
      </View>
    );
  }
  return (
    <View>
      <Mono style={{ marginBottom: 4 }}>Chapters · tap a line to jump the video there</Mono>
      {chapters.map((c) => (
        <Pressable
          key={c.startSeconds}
          accessibilityRole="button"
          accessibilityLabel={`${timestamp(c.startSeconds)}, ${c.title}. Opens YouTube there.`}
          onPress={() => onOpen(c.startSeconds)}
          style={({ pressed }) => ({ flexDirection: "row", gap: 12, alignItems: "flex-start", borderBottomWidth: 1, borderBottomColor: palette.rule, paddingVertical: 12, opacity: pressed ? 0.6 : 1 })}
        >
          <Text style={{ width: 42, paddingTop: 3, fontFamily: font.mono, fontSize: 12, color: palette.blue }}>{timestamp(c.startSeconds)}</Text>
          <View style={{ flex: 1, gap: 4 }}>
            <Text style={{ fontFamily: font.bodySemi, fontSize: 16, color: palette.ink }}>{c.title}</Text>
            <Text style={{ fontFamily: font.body, fontSize: 15.5, lineHeight: 23.25, color: palette.promptInk }}>{c.text}</Text>
          </View>
        </Pressable>
      ))}
    </View>
  );
}

function SummaryCard({ state, onRetry }: { state: SummaryState; onRetry: () => void }) {
  if (state.status === "error") return <InlineError message="Couldn't summarize this section." onRetry={onRetry} />;
  return (
    <View accessibilityLiveRegion="polite" style={{ gap: 6, backgroundColor: palette.blueTint, borderRadius: 16, padding: 14 }}>
      <Mono color={palette.blue}>Summary of this section</Mono>
      {state.status === "loading" ? (
        <ActivityIndicator color={palette.blue} style={{ alignSelf: "flex-start" }} accessibilityLabel="Summarizing" />
      ) : (
        <Text style={{ fontFamily: font.body, fontSize: 15.5, lineHeight: 23.25, color: palette.blueInk }}>
          <B>Claim:</B> {state.summary.claim} <B>Evidence:</B> {state.summary.evidence} <B>For you:</B> {state.summary.forYou}
        </Text>
      )}
    </View>
  );
}

const B = ({ children }: { children: ReactNode }) => <Text style={{ fontFamily: font.bodySemi }}>{children}</Text>;

function DigestBadge({ short }: { short?: boolean }) {
  return (
    <View accessibilityRole="text" style={{ borderRadius: 8, paddingVertical: 4, paddingHorizontal: 9, backgroundColor: palette.tints[2] }}>
      <Text style={{ fontFamily: font.bodySemi, fontSize: 13, color: palette.promptInk }}>{short ? "Digest" : "Digest, not the original text"}</Text>
    </View>
  );
}

const UNAVAILABLE: Record<string, string> = {
  paywalled: "This one is behind a paywall, so there's nothing to show here. The original is a tap away.",
  transcript_missing: "There's no transcript for this yet.",
};

function Unavailable({ reason, onOpen }: { reason: string | null; onOpen?: () => void }) {
  return (
    <View style={{ gap: 12 }}>
      <Text style={{ fontFamily: font.body, fontSize: 16, lineHeight: 24, color: palette.promptInk }}>
        {(reason && UNAVAILABLE[reason]) ?? "The text of this one can't be shown in the app. Read it on the publisher's site."}
      </Text>
      {onOpen && (
        <View style={{ flexDirection: "row" }}>
          <SheetButton title="Open the original" icon onPress={onOpen} />
        </View>
      )}
    </View>
  );
}

/** The compact header (.rhead.compact): back, then the title on one line. */
function CompactBar({ title, digest, backLabel, onBack }: { title: string; digest: boolean; backLabel: string; onBack: () => void }) {
  return (
    <>
      <RoundButton icon="chevron-down" label={backLabel} onPress={onBack} light style={{ bottom: 6, left: 14 }} />
      <View style={{ position: "absolute", left: 66, right: 16, bottom: 14, flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text numberOfLines={1} style={{ flex: 1, fontFamily: font.display, fontSize: 17, lineHeight: 21, letterSpacing: -0.4, color: palette.ink }}>
          {title}
        </Text>
        {digest && <DigestBadge short />}
      </View>
    </>
  );
}

function RoundButton({ icon, label, onPress, light, style }: { icon: PagerIconName; label: string; onPress: () => void; light?: boolean; style: object }) {
  const size = light ? 40 : 44;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={light ? 4 : 0}
      style={[
        { position: "absolute", zIndex: 3, width: size, height: size, borderRadius: size / 2, alignItems: "center", justifyContent: "center", backgroundColor: light ? palette.rule : "rgba(18,19,22,0.4)" },
        style,
      ]}
    >
      <PagerIcon name={icon} size={22} color={light ? palette.ink : "#FFFFFF"} />
    </Pressable>
  );
}

function TrayItem({ icon, glyph, title, note, onPress }: { icon?: PagerIconName; glyph?: string; title: string; note?: string; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="menuitem"
      accessibilityLabel={note ? `${title}, ${note}` : title}
      onPress={onPress}
      style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 12, minHeight: 48, paddingHorizontal: 12, borderRadius: 14, backgroundColor: pressed ? "rgba(255,255,255,0.08)" : "transparent" })}
    >
      {icon ? (
        <PagerIcon name={icon} color="#FFFFFF" />
      ) : (
        <Text style={{ width: 20, textAlign: "center", fontFamily: font.display, fontSize: 15, color: "#FFFFFF" }}>{glyph}</Text>
      )}
      <Text style={{ fontFamily: font.body, fontSize: 15.5, color: "#FFFFFF" }}>{title}</Text>
      {note ? <Mono style={{ marginLeft: "auto" }} color={palette.pillMuted}>{note}</Mono> : null}
    </Pressable>
  );
}

