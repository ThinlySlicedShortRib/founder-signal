import type { AuthorCard, DislikeReason, ItemView, LikeReason, PieceImage, ReviewVote, Section, SectionSummary } from "@fs/schema";
import { dislikeReasons, likeReasons } from "@fs/schema";
import * as Clipboard from "expo-clipboard";
import { Image } from "expo-image";
import { StatusBar } from "expo-status-bar";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Linking, Pressable, Share, StyleSheet, Text, View } from "react-native";
import Animated, {
  Extrapolation,
  interpolate,
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
import { Pill, PillAction, PillButton, PillStatus, PillStatusText, usePillSpace } from "@/components/pager/Pill";
import { AgentLine, Display, Mono } from "@/components/pager/PagerScreen";
import { Sheet } from "@/components/pager/Sheet";
import { timestamp } from "@/lib/format";
import { DISLIKE_LABELS, LIKE_LABELS, setPieceState, track, usePieceState, useItem, useSectionSummary, useToggleSave } from "@/lib/letters";
import { useReview } from "@/lib/profile";
import { AuthorCardView, AuthorChip, SheetButton } from "./Author";
import { BlockView, TEXT_SIZES, type TextSize } from "./BlockRenderer";
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

const HEAD_MAX = 200;
const HEAD_MIN = 72;
/** The header turns into the plain white bar once it's this short (the board's `≤ 96`). */
const COMPACT_AT = 96;
const PLAYER = 220;

type SummaryState = { status: "loading" } | { status: "error" } | { status: "done"; summary: SectionSummary };

/**
 * Reading in place (PagerReader / PagerVideo). The photo header shrinks with
 * scrolling to a white bar; every action is in the pill; at the end the pill
 * asks for the verdict, then offers the next piece.
 */
export function Reader({
  meta,
  next,
  onBack,
  backLabel = "Back to the piece page",
  onSkip,
  onMenu,
  onAuthor,
}: {
  meta: ReaderMeta;
  next: UpNext;
  onBack: () => void;
  backLabel?: string;
  onSkip?: () => void;
  onMenu: () => void;
  onAuthor: () => void;
}) {
  const insets = useSafeAreaInsets();
  const pill = usePillSpace();
  const reduceMotion = useReducedMotion();
  const item = useItem(meta.itemId);
  const state = usePieceState(meta.itemId, { saved: meta.saved, verdict: meta.verdict, completed: meta.completed });
  const toggleSave = useToggleSave();
  const review = useReview();
  const summarize = useSectionSummary(meta.itemId);

  const data = item.data;
  const kind = data?.kind ?? meta.kind;
  const video = kind === "video";
  const title = data?.title ?? meta.title;
  const minutes = data?.minutes ?? meta.minutes ?? 1;
  const originalUrl = data?.originalUrl ?? meta.originalUrl;
  const headMax = (video ? PLAYER : HEAD_MAX) + insets.top;
  const headMin = HEAD_MIN + insets.top;

  // ── Scroll position, progress, sections ────────────────────────────────────
  const scrollRef = useAnimatedRef<Animated.ScrollView>();
  const scrollY = useSharedValue(0);
  const yRef = useRef(0);
  const viewH = useRef(0);
  const contentH = useRef(0);
  const sectionY = useRef(new Map<string, number>());
  const endY = useRef<number | null>(null);
  const [progress, setProgress] = useState(0);
  const [compact, setCompact] = useState(false);
  const [atEnd, setAtEnd] = useState(false);
  const [nextIsEnd, setNextIsEnd] = useState(false);

  const recompute = useCallback(() => {
    const y = yRef.current;
    const max = contentH.current - viewH.current;
    setProgress(max > 0 ? Math.round(Math.min(1, Math.max(0, y / max)) * 100) / 100 : 1);
    setCompact(!video && headMax - insets.top - y <= COMPACT_AT);
    const end = endY.current;
    // The end card in view; until it's been measured, the board's rule (92% scrolled).
    setAtEnd(end !== null ? viewH.current > 0 && y + viewH.current >= end + 80 : max > 0 && y / max > 0.92);
    const targets = [...sectionY.current.values()].filter((v) => v > y + headMin + 8);
    setNextIsEnd(targets.length === 0);
  }, [video, headMax, headMin, insets.top]);

  const onTick = useCallback(
    (y: number, view: number, content: number) => {
      yRef.current = y;
      if (view > 0) viewH.current = view;
      if (content > 0) contentH.current = content;
      recompute();
    },
    [recompute],
  );

  // Progress, the compact bar and the end are worked out on the JS side every 6px of scrolling.
  const lastTick = useSharedValue(-100);
  const onScroll = useAnimatedScrollHandler((e) => {
    const y = e.contentOffset.y;
    scrollY.set(y);
    if (Math.abs(y - lastTick.get()) >= 6) {
      lastTick.set(y);
      scheduleOnRN(onTick, y, e.layoutMeasurement.height, e.contentSize.height);
    }
  });

  // ── Events ─────────────────────────────────────────────────────────────────
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    track("open", meta.itemId, meta.letterId);
  }, [meta.itemId, meta.letterId]);

  const completed = useRef(meta.completed);
  useEffect(() => {
    if (!atEnd || completed.current || !data) return;
    completed.current = true;
    setPieceState(meta.itemId, { completed: true });
    track("complete", meta.itemId, meta.letterId);
  }, [atEnd, data, meta.itemId, meta.letterId]);

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

  function sectionInView(): Section | undefined {
    let found = sections[0];
    for (const s of sections) {
      const y = sectionY.current.get(s.id);
      if (y !== undefined && y <= yRef.current + headMin + 48) found = s;
    }
    return found;
  }

  function scrollToY(y: number) {
    scrollRef.current?.scrollTo({ y: Math.max(0, y), animated: !reduceMotion });
  }

  function nextSection() {
    const targets = [...sectionY.current.values()].filter((v) => v > yRef.current + headMin + 8).sort((a, b) => a - b);
    const target = targets[0] ?? endY.current;
    if (target !== null && target !== undefined) scrollToY(target - headMin - 12);
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

  // ── Header styles ──────────────────────────────────────────────────────────
  const headStyle = useAnimatedStyle(() => ({ height: video ? headMax : Math.max(headMin, headMax - Math.max(0, scrollY.get())) }));
  const collapseAt = HEAD_MAX - COMPACT_AT;
  const photoStyle = useAnimatedStyle(() => ({ opacity: interpolate(scrollY.get(), [collapseAt - 8, collapseAt], [1, 0], Extrapolation.CLAMP) }));
  const barStyle = useAnimatedStyle(() => ({ opacity: interpolate(scrollY.get(), [collapseAt - 8, collapseAt], [0, 1], Extrapolation.CLAMP) }));

  const kicker = [meta.position && meta.pieceCount ? `Piece ${meta.position} of ${meta.pieceCount}` : null, meta.topic].filter(Boolean).join(" · ");
  const sourceRights = video ? (data?.video?.chapters?.length ? "transcript" : "video") : data?.blocks ? "full text" : data?.digest ? "digest" : null;
  const digestMode = !video && !!data && !data.blocks && !!data.digest;
  const textStyle = { fontFamily: font.body, color: palette.ink, ...TEXT_SIZES[size] };

  function openVideo(at = 0) {
    const id = data?.video?.youtubeId;
    const url = id ? `https://www.youtube.com/watch?v=${id}${at ? `&t=${at}s` : ""}` : originalUrl;
    if (url) void Linking.openURL(url);
  }

  return (
    <View style={{ flex: 1, backgroundColor: palette.surface }}>
      <StatusBar style={compact ? "dark" : "light"} />
      <Animated.ScrollView
        ref={scrollRef}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onLayout={(e) => {
          viewH.current = e.nativeEvent.layout.height;
          recompute();
        }}
        onContentSizeChange={(_w, h) => {
          contentH.current = h;
          recompute();
        }}
        contentContainerStyle={{ paddingTop: headMax }}
      >
        <View style={{ backgroundColor: palette.surface, paddingTop: 18, paddingHorizontal: 20, paddingBottom: pill.space + 16, gap: 18 }}>
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
          {meta.image?.credit && (
            <Pressable accessibilityRole="link" disabled={!meta.image.creditUrl} onPress={() => meta.image?.creditUrl && void Linking.openURL(meta.image.creditUrl)} style={{ marginTop: -10 }}>
              <Text style={{ fontFamily: font.body, fontSize: 12.5, color: palette.offText }}>
                {meta.image.source === "stock" ? "Stock photo" : "Photo"}: {meta.image.credit}
              </Text>
            </Pressable>
          )}
          {meta.author && <AuthorChip author={meta.author} onPress={onAuthor} />}
          {meta.whyPicked && (
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
            sections.map((s) => {
              const blocks = data.blocks!.slice(s.startBlock, s.endBlock);
              const headed = blocks[0]?.type === "heading";
              const sum = summaries[s.id];
              return (
                <View
                  key={s.id}
                  style={{ gap: 18 }}
                  onLayout={(e) => {
                    sectionY.current.set(s.id, headMax + e.nativeEvent.layout.y);
                    recompute();
                  }}
                >
                  {headed && <BlockView block={blocks[0]!} size={size} />}
                  {sum && <SummaryCard state={sum} onRetry={toggleSummary} />}
                  {blocks.slice(headed ? 1 : 0).map((b, i) => (
                    <BlockView key={i} block={b} size={size} />
                  ))}
                </View>
              );
            })
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
              {data!.digest!
                .split(/\n{2,}/)
                .filter(Boolean)
                .map((p, i) => (
                  <Text key={i} style={textStyle}>
                    {p}
                  </Text>
                ))}
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
              endY.current = headMax + e.nativeEvent.layout.y;
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
      </Animated.ScrollView>

      {/* Header: the photo, shrinking to a plain white bar (.rhead / .rhead.compact), or the video still (.player). */}
      <Animated.View style={[{ position: "absolute", top: 0, left: 0, right: 0, overflow: "hidden", zIndex: 5 }, headStyle]}>
        {video ? (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: palette.ink }]}>
            {meta.image && <Image source={{ uri: meta.image.url }} style={[StyleSheet.absoluteFill, { opacity: 0.55 }]} contentFit="cover" />}
            <RoundButton icon="chevron-down" label={backLabel} onPress={onBack} style={{ top: insets.top + 18, left: 14 }} />
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
              <RoundButton icon="chevron-down" label={backLabel} onPress={onBack} style={{ top: insets.top + 18, left: 14 }} />
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
              <RoundButton icon="chevron-down" label={backLabel} onPress={onBack} light style={{ bottom: 6, left: 14 }} />
              <View style={{ position: "absolute", left: 66, right: 16, bottom: 14, flexDirection: "row", alignItems: "center", gap: 8 }}>
                <Text numberOfLines={1} style={{ flex: 1, fontFamily: font.display, fontSize: 17, lineHeight: 21, letterSpacing: -0.4, color: palette.ink }}>
                  {title}
                </Text>
                {digestMode && <DigestBadge short />}
              </View>
            </Animated.View>
          </>
        )}
      </Animated.View>

      {/* The tray (.tray) */}
      {tray && (
        <>
          <Pressable accessibilityLabel="Close the menu" onPress={() => setTray(false)} style={[StyleSheet.absoluteFill, { zIndex: 19 }]} />
          <View
            accessibilityRole="menu"
            accessibilityLabel="More"
            style={{
              position: "absolute",
              bottom: pill.bottom + 66,
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
                onBack();
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

      {/* The pill: reading → verdict → next */}
      {showNextPill ? (
        <Pill label="Next">
          <PillStatus label={state.verdict === "interested" ? "Worth it. Noted." : "Less like this."}>
            <PagerIcon name="check" size={18} color={palette.blueMid} />
            <PillStatusText>{state.verdict === "interested" ? "Worth it. Noted." : "Less like this."}</PillStatusText>
          </PillStatus>
          <PillAction title={`${next.short} ↓`} label={`${next.kicker}: ${next.title}`} onPress={next.onPress} primary />
        </Pill>
      ) : showEndPill ? (
        <Pill label="Was it worth it?">
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
        <Pill label="Reading">
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
        <View style={{ pointerEvents: "none", position: "absolute", left: 20, right: 20, bottom: pill.bottom + 62, zIndex: 18 }}>
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

