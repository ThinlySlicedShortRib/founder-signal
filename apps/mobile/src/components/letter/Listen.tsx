import type { EpisodeView } from "@fs/schema";
import { setAudioModeAsync, useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { font, palette } from "@/components/onboarding/kit";
import { PagerIcon } from "@/components/pager/icons";
import { Mono } from "@/components/pager/PagerScreen";
import { timestamp } from "@/lib/format";
import { episodeAudioUrl, isMaking, useEpisode, useRequestEpisode } from "@/lib/podcast";

/**
 * "Listen" (the podcast experiment): the piece as a short episode, two hosts
 * talking it through. At the top of an article: a button to ask for it, a
 * note while the workers make it, then a small player with play/pause, a
 * scrubber, the time and the chapter you're in. Only for pieces the app may
 * show in full.
 */
export function ListenCard({ itemId }: { itemId: string }) {
  const query = useEpisode(itemId);
  const request = useRequestEpisode(itemId);
  const episode = query.data?.episode ?? null;
  if (!query.data?.available) return null;

  if (episode?.status === "ready" && episode.audioUrl) return <EpisodePlayer episode={episode} />;

  const making = isMaking(episode) || request.isPending;
  const failed = episode?.status === "failed" || request.isError;
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12, borderRadius: 18, padding: 14, backgroundColor: palette.blueTint }}>
      <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: palette.blue, alignItems: "center", justifyContent: "center" }}>
        {making ? <ActivityIndicator color="#FFFFFF" /> : <PagerIcon name="headphones" color="#FFFFFF" />}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Mono color={palette.blueInk}>{making ? "Making the episode" : "Listen"}</Mono>
        <Text style={{ fontFamily: font.body, fontSize: 14.5, lineHeight: 20, color: palette.ink }}>
          {making ? "Two hosts talk it through. A few minutes; you can keep reading." : failed ? "Couldn't make the episode." : "Hear it as a short two-host episode."}
        </Text>
      </View>
      {!making && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={failed ? "Try making the episode again" : "Make an episode of this piece"}
          onPress={() => request.mutate()}
          style={({ pressed }) => ({ minHeight: 44, borderRadius: 999, paddingHorizontal: 16, justifyContent: "center", backgroundColor: palette.ink, opacity: pressed ? 0.85 : 1 })}
        >
          <Text style={{ fontFamily: font.bodySemi, fontSize: 15, color: "#FFFFFF" }}>{failed ? "Try again" : "Listen"}</Text>
        </Pressable>
      )}
    </View>
  );
}

function EpisodePlayer({ episode }: { episode: EpisodeView }) {
  const player = useAudioPlayer(episodeAudioUrl(episode), { updateInterval: 250 });
  const status = useAudioPlayerStatus(player);
  const duration = status.duration || episode.durationSeconds || 0;
  const [scrub, setScrub] = useState<number | null>(null);
  const at = scrub ?? status.currentTime;
  const chapter = [...episode.chapters].reverse().find((c) => c.startSeconds <= at + 0.5);

  useEffect(() => {
    void setAudioModeAsync({ playsInSilentMode: true });
  }, []);

  const toggle = () => {
    if (status.playing) return player.pause();
    // At the end the player stays there; start again from the top.
    if (duration && status.currentTime >= duration - 0.5) void player.seekTo(0);
    player.play();
  };

  return (
    <View style={{ gap: 10, borderRadius: 18, padding: 14, backgroundColor: palette.pill }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={status.playing ? "Pause the episode" : "Play the episode"}
          onPress={toggle}
          style={({ pressed }) => ({ width: 44, height: 44, borderRadius: 22, backgroundColor: palette.blue, alignItems: "center", justifyContent: "center", opacity: pressed ? 0.8 : 1 })}
        >
          {status.isBuffering && !status.playing ? <ActivityIndicator color="#FFFFFF" /> : <PagerIcon name={status.playing ? "pause" : "play"} size={18} color="#FFFFFF" />}
        </Pressable>
        <View style={{ flex: 1, gap: 2 }}>
          <Mono color={palette.pillMuted}>{episode.format === "reading" ? "Read aloud" : "Episode"}</Mono>
          <Text numberOfLines={1} style={{ fontFamily: font.bodySemi, fontSize: 15, color: "#FFFFFF" }}>
            {chapter?.title ?? "The piece, out loud"}
          </Text>
        </View>
        <Text style={{ fontFamily: font.mono, fontSize: 12, color: palette.pillMuted }} accessibilityLabel={`${timestamp(Math.floor(at))} of ${timestamp(Math.floor(duration))}`}>
          {timestamp(Math.floor(at))} / {timestamp(Math.floor(duration))}
        </Text>
      </View>
      <Scrubber
        progress={duration ? at / duration : 0}
        marks={duration ? episode.chapters.slice(1).map((c) => c.startSeconds / duration) : []}
        onScrub={(p) => setScrub(p * duration)}
        onSeek={(p) => {
          setScrub(null);
          void player.seekTo(p * duration);
        }}
      />
      {!!status.error && <Text style={{ fontFamily: font.body, fontSize: 13, color: palette.orange }}>{"Couldn't play the episode."}</Text>}
    </View>
  );
}

/** A thin track you can tap or drag along; chapter starts are ticks. */
function Scrubber({ progress, marks, onScrub, onSeek }: { progress: number; marks: number[]; onScrub: (p: number) => void; onSeek: (p: number) => void }) {
  const width = useRef(1);
  const at = (x: number) => Math.max(0, Math.min(1, x / width.current));
  const p = Math.max(0, Math.min(1, progress));
  return (
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Position in the episode"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(p * 100) }}
      accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
      onAccessibilityAction={(e) => onSeek(Math.max(0, Math.min(1, p + (e.nativeEvent.actionName === "increment" ? 0.05 : -0.05))))}
      onLayout={(e) => (width.current = Math.max(1, e.nativeEvent.layout.width))}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      // Keep the drag when the reader's scroll view would like it.
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => onScrub(at(e.nativeEvent.locationX))}
      onResponderMove={(e) => onScrub(at(e.nativeEvent.locationX))}
      onResponderRelease={(e) => onSeek(at(e.nativeEvent.locationX))}
      style={{ height: 28, justifyContent: "center" }}
    >
      <View style={{ height: 4, borderRadius: 2, backgroundColor: "rgba(255,255,255,0.2)", pointerEvents: "none" }}>
        <View style={{ width: `${p * 100}%`, height: 4, borderRadius: 2, backgroundColor: palette.blue }} />
        {marks.map((m) => (
          <View key={m} style={{ position: "absolute", left: `${m * 100}%`, top: -2, width: 2, height: 8, borderRadius: 1, backgroundColor: "rgba(255,255,255,0.55)" }} />
        ))}
      </View>
      <View style={{ position: "absolute", left: `${p * 100}%`, marginLeft: -7, width: 14, height: 14, borderRadius: 7, backgroundColor: "#FFFFFF", pointerEvents: "none" }} />
    </View>
  );
}
