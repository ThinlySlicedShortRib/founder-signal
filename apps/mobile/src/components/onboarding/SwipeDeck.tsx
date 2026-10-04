import type { CalibrationPick, LikeReason } from "@fs/schema";
import { useEffect, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { capitalize, LIKE_REASONS } from "@/lib/onboarding";
import { BoardIcon } from "./icons";
import { Chip, Chips, LinkButton, OButton, OText, em, font, usePalette } from "./kit";

const SWIPE_THRESHOLD = 110;
/** transition: transform .22s ease */
const EASE = { duration: 220, easing: Easing.bezier(0.25, 0.1, 0.25, 1), useNativeDriver: true };

/** One pick card (design: "Swipe card E · B + D", a pull quote on a soft tint). */
function PickCard({ pick, index }: { pick: CalibrationPick; index: number }) {
  const p = usePalette();
  const length = pick.readTimeMinutes ? (pick.type === "video" ? `${pick.readTimeMinutes} min` : `${pick.readTimeMinutes} min read`) : null;
  const topic = pick.matchedTopic ?? pick.tags[0] ?? null;
  const why = pick.matchedTopic
    ? `Because you're into ${pick.matchedTopic}.`
    : pick.fromFollowedSource
      ? `From ${pick.publisher}, one of your sources.`
      : "A wildcard: something new to you.";
  return (
    <View
      style={{
        flex: 1,
        borderRadius: 24,
        padding: 22,
        gap: 12,
        backgroundColor: p.tints[index % p.tints.length],
        // box-shadow: 0 14px 34px rgba(18,19,22,.08)
        shadowColor: "#121316",
        shadowOpacity: 0.08,
        shadowRadius: 17,
        shadowOffset: { width: 0, height: 14 },
        elevation: 4,
      }}
    >
      <View style={{ flexDirection: "row", gap: 6, flexWrap: "wrap" }}>
        <Pill icon={pick.type === "video" ? "video" : "article"} label={[pick.type === "video" ? "Video" : "Article", length].filter(Boolean).join(" · ")} />
        {topic && <Pill label={capitalize(topic)} />}
      </View>
      {pick.quote ? (
        <>
          {/* .qm: 72px at line-height .6, in a 30px box, 14px down */}
          <View style={{ height: 30, marginTop: 14, overflow: "visible" }}>
            <Text importantForAccessibility="no" style={{ fontFamily: font.display, fontSize: 72, lineHeight: 72, marginTop: -8, color: p.blue }}>
              {"“"}
            </Text>
          </View>
          <Text style={{ fontFamily: font.display, fontSize: 30, lineHeight: 33, letterSpacing: em(-0.025, 30), color: p.ink }} numberOfLines={7} adjustsFontSizeToFit minimumFontScale={0.7}>
            {pick.quote}
          </Text>
        </>
      ) : (
        <Text style={{ fontFamily: font.display, fontSize: 30, lineHeight: 33, letterSpacing: em(-0.025, 30), color: p.ink, marginTop: 14 }} numberOfLines={6}>
          {pick.title}
        </Text>
      )}
      <View style={{ flexGrow: 1 }} />
      <View style={{ gap: 3, borderTopWidth: 1, borderTopColor: p.cardRule, paddingTop: 12 }}>
        {pick.quote && (
          <Text style={{ fontFamily: font.bodySemi, fontSize: 16, lineHeight: 20.8, color: p.ink }} numberOfLines={2}>
            {pick.title}
          </Text>
        )}
        <OText variant="mono" color={p.soft} numberOfLines={1}>
          {[pick.publisher, pick.creator].filter(Boolean).join(" · ")}
        </OText>
      </View>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start", backgroundColor: p.whyOnTint, borderRadius: 12, paddingHorizontal: 11, paddingVertical: 9 }}>
        <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: p.orange, marginTop: 1 }} />
        <Text style={{ flex: 1, fontFamily: font.body, fontSize: 14, lineHeight: 19.6, color: p.noteInk }}>{why}</Text>
      </View>
    </View>
  );
}

function Pill({ label, icon }: { label: string; icon?: "video" | "article" }) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, backgroundColor: p.pillOnTint, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 5 }}>
      {icon && <BoardIcon name={icon} size={16} color={p.ink} />}
      <Text style={{ fontFamily: font.bodySemi, fontSize: 13, lineHeight: 17, color: p.ink }}>{label}</Text>
    </View>
  );
}

export interface Like {
  pick: CalibrationPick;
  reasons: LikeReason[];
  why: string;
}

/**
 * "Five picks for you. Swipe right if you'd read it." Drag the card or use
 * the buttons; each right swipe asks what they liked about it.
 */
export function SwipeDeck({
  picks,
  onSkip,
  onLike,
  onFinished,
}: {
  picks: CalibrationPick[];
  onSkip: (pick: CalibrationPick) => void;
  onLike: (like: Like) => void;
  onFinished: () => void;
}) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  // The board flies the card 520px; far enough to clear any screen.
  const flyOut = Math.max(520, useWindowDimensions().width + 200);
  const [index, setIndex] = useState(0);
  const [stamp, setStamp] = useState<"yes" | "no" | null>(null);
  const [liking, setLiking] = useState<CalibrationPick | null>(null);
  const [dx] = useState(() => new Animated.Value(0));
  // One swipe at a time: a second tap mid-animation would answer the same card twice.
  const busy = useRef(false);
  const pick = picks[index];

  const advance = () => {
    busy.current = false;
    dx.setValue(0);
    setStamp(null);
    if (index + 1 >= picks.length) onFinished();
    else setIndex(index + 1);
  };

  const swipe = (liked: boolean) => {
    if (!pick || busy.current) return;
    busy.current = true;
    AccessibilityInfo.announceForAccessibility(liked ? "Marked as one you'd read" : "Skipped");
    Animated.timing(dx, { toValue: liked ? flyOut : -flyOut, ...EASE }).start(() => {
      if (liked) setLiking(pick);
      else {
        onSkip(pick);
        advance();
      }
    });
  };

  const snapBack = () => {
    setStamp(null);
    Animated.timing(dx, { toValue: 0, ...EASE }).start();
  };

  // The responder is made once; it calls through to this render's handlers.
  const latest = useRef({ swipe, snapBack });
  useEffect(() => {
    latest.current = { swipe, snapBack };
  });
  // The ref is read only inside gesture callbacks, never while rendering; the rule can't see that.
  // eslint-disable-next-line react-hooks/refs
  const [responder] = useState(() =>
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 8 && Math.abs(g.dx) > Math.abs(g.dy),
      onPanResponderMove: (_, g) => {
        dx.setValue(g.dx);
        setStamp(g.dx > 40 ? "yes" : g.dx < -40 ? "no" : null);
      },
      onPanResponderRelease: (_, g) => {
        if (g.dx > SWIPE_THRESHOLD) latest.current.swipe(true);
        else if (g.dx < -SWIPE_THRESHOLD) latest.current.swipe(false);
        else latest.current.snapBack();
      },
      onPanResponderTerminate: () => latest.current.snapBack(),
    }),
  );

  if (!pick) return null;
  // rotate(dx / 18 deg)
  const rotate = dx.interpolate({ inputRange: [-18, 0, 18], outputRange: ["-1deg", "0deg", "1deg"], extrapolate: "extend" });

  return (
    <View style={{ flex: 1, paddingTop: insets.top + 28, paddingBottom: insets.bottom + 24, paddingHorizontal: 20, gap: 14 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
        <OText variant="mono">Before your first letter</OText>
        <OText variant="mono" accessibilityLabel={`Pick ${index + 1} of ${picks.length}`}>
          {index + 1} / {picks.length}
        </OText>
      </View>
      <OText variant="display" style={{ fontSize: 26, lineHeight: 28.6 }}>
        {picks.length === 5 ? "Five picks for you." : `${picks.length} pick${picks.length === 1 ? "" : "s"} for you.`} Swipe right if you’d read it.
      </OText>

      <View style={{ height: 470 }}>
        {index + 1 < picks.length && <View style={{ position: "absolute", left: 16, right: 16, top: 16, bottom: -12, backgroundColor: p.grey, borderRadius: 26 }} />}
        <Animated.View
          {...responder.panHandlers}
          accessible
          accessibilityLabel={`${pick.title}, from ${pick.publisher}.${pick.quote ? ` “${pick.quote}”` : ""}`}
          accessibilityActions={[
            { name: "activate", label: "I'd read it" },
            { name: "increment", label: "I'd read it" },
            { name: "decrement", label: "Skip" },
          ]}
          onAccessibilityAction={(e) => swipe(e.nativeEvent.actionName !== "decrement")}
          style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, transform: [{ translateX: dx }, { rotate }] }}
        >
          <PickCard pick={pick} index={index} />
          {stamp && <Stamp kind={stamp} />}
        </Animated.View>
      </View>

      <View style={{ flexGrow: 1 }} />
      <View style={{ flexDirection: "row", justifyContent: "center", gap: 30 }}>
        <RoundButton label="Skip" icon="x" bg={p.surface} fg={p.no} shadow onPress={() => swipe(false)} />
        <RoundButton label="I'd read it" icon="check" bg={p.blue} fg={p.onBlue} onPress={() => swipe(true)} />
      </View>
      <OText variant="small" style={{ textAlign: "center" }}>
        Drag the card, or use the buttons.
      </OText>

      <LikeSheet
        pick={liking}
        onDone={(reasons, why) => {
          if (liking) onLike({ pick: liking, reasons, why });
          setLiking(null);
          advance();
        }}
      />
    </View>
  );
}

/** .stamp.yes / .stamp.no */
function Stamp({ kind }: { kind: "yes" | "no" }) {
  const p = usePalette();
  const color = kind === "yes" ? p.yes : p.no;
  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        zIndex: 2,
        top: 22,
        [kind === "yes" ? "left" : "right"]: 18,
        transform: [{ rotate: kind === "yes" ? "-12deg" : "12deg" }],
        borderWidth: 3,
        borderColor: color,
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 6,
        backgroundColor: p.stampBg,
      }}
    >
      <Text style={{ fontFamily: font.display, fontSize: 22, lineHeight: 26, color }}>{kind === "yes" ? "I'd read it" : "Skip"}</Text>
    </View>
  );
}

/** .round: 64px; the skip button is white with a soft shadow. */
function RoundButton({ label, icon, bg, fg, shadow, onPress }: { label: string; icon: "x" | "check"; bg: string; fg: string; shadow?: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 64,
        height: 64,
        borderRadius: 32,
        backgroundColor: bg,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.85 : 1,
        // box-shadow: 0 4px 14px rgba(18,19,22,.10)
        ...(shadow ? { shadowColor: "#121316", shadowOpacity: 0.1, shadowRadius: 7, shadowOffset: { width: 0, height: 4 }, elevation: 3 } : null),
      })}
    >
      <BoardIcon name={icon} size={26} color={fg} strokeWidth={2.4} />
    </Pressable>
  );
}

/** .sheet: "What did you like about it?" after a right swipe, multi-select plus free text. */
function LikeSheet({ pick, onDone }: { pick: CalibrationPick | null; onDone: (reasons: LikeReason[], why: string) => void }) {
  const p = usePalette();
  const insets = useSafeAreaInsets();
  const [reasons, setReasons] = useState<LikeReason[]>([]);
  const [why, setWhy] = useState("");
  const close = (save: boolean) => {
    onDone(save ? reasons : [], save ? why.trim() : "");
    setReasons([]);
    setWhy("");
  };
  return (
    <Modal visible={!!pick} transparent animationType="fade" onRequestClose={() => close(false)}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, justifyContent: "flex-end", backgroundColor: p.scrim }}>
        <ScrollView
          accessibilityViewIsModal
          keyboardShouldPersistTaps="handled"
          style={{ flexGrow: 0, maxHeight: "92%", backgroundColor: p.surface, borderTopLeftRadius: 24, borderTopRightRadius: 24, width: "100%", maxWidth: 560, alignSelf: "center" }}
          contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 20, paddingBottom: insets.bottom + 26, gap: 12 }}
        >
          <OText variant="mono" numberOfLines={2}>
            You’d read: {pick?.title}
          </OText>
          <OText variant="display" style={{ fontSize: 22, lineHeight: 26.4, letterSpacing: em(-0.02, 22) }}>
            What did you like about it?
          </OText>
          <Chips>
            {LIKE_REASONS.map((r) => {
              const on = reasons.includes(r.value);
              return <Chip key={r.value} label={r.label} on={on} onPress={() => setReasons(on ? reasons.filter((x) => x !== r.value) : [...reasons, r.value])} />;
            })}
          </Chips>
          <OText variant="mono" nativeID="why-label">
            Anything else? (optional)
          </OText>
          <TextInput
            accessibilityLabelledBy="why-label"
            accessibilityLabel="Anything else you liked"
            value={why}
            onChangeText={setWhy}
            placeholder="e.g. I like when founders share real numbers"
            placeholderTextColor={p.muted}
            multiline
            maxLength={1000}
            textAlignVertical="top"
            style={{ minHeight: 80, borderWidth: 1.5, borderColor: p.line, borderRadius: 14, paddingVertical: 11, paddingHorizontal: 13, fontFamily: font.body, fontSize: 15, lineHeight: 21, color: p.ink, backgroundColor: p.surface }}
          />
          <OButton title="Save" onPress={() => close(true)} />
          <LinkButton title="Skip" onPress={() => close(false)} />
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
