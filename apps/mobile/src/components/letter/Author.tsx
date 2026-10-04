import type { AuthorCard as Author } from "@fs/schema";
import { router } from "expo-router";
import { Linking, Pressable, Text, View } from "react-native";
import { font, palette } from "@/components/onboarding/kit";
import { PagerIcon } from "@/components/pager/icons";
import { Display, Mono } from "@/components/pager/PagerScreen";
import { Sheet } from "@/components/pager/Sheet";
import { firstName } from "@/lib/format";
import { authorWithLocal, useFollowAuthor, useLocalVersion } from "@/lib/letters";
import { Avatar } from "./Photo";

/** .stats: up to three number tiles. */
function Stats({ stats, tile }: { stats: Author["stats"]; tile: string }) {
  if (!stats.length) return null;
  return (
    <View style={{ flexDirection: "row", gap: 6 }}>
      {stats.map((s) => (
        <View
          key={`${s.value}${s.label}`}
          accessible
          accessibilityLabel={`${s.value} ${s.label}`}
          style={{ flex: 1, backgroundColor: tile, borderWidth: 1, borderColor: palette.rule, borderRadius: 14, paddingTop: 10, paddingHorizontal: 10, paddingBottom: 9, gap: 2 }}
        >
          <Text style={{ fontFamily: font.display, fontSize: 22, lineHeight: 24, letterSpacing: -0.55, color: palette.ink }}>{s.value}</Text>
          <Text style={{ fontFamily: font.body, fontSize: 12, lineHeight: 15.6, color: palette.muted }}>{s.label}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The compact author pill: avatar, name and headline, tap for the full dialog. `onPhoto` is the
 * piece page's frosted version over the photo; otherwise it sits on the reader's white page.
 */
export function AuthorChip({ author, onPress, onPhoto }: { author: Author; onPress: () => void; onPhoto?: boolean }) {
  const ink = onPhoto ? "#FFFFFF" : palette.ink;
  const sub = onPhoto ? "rgba(255,255,255,0.78)" : palette.muted;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`About the author, ${author.name}`}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
        alignSelf: "flex-start",
        maxWidth: "100%",
        backgroundColor: onPhoto ? "rgba(255,255,255,0.14)" : "#F6F7F9",
        borderWidth: 1,
        borderColor: onPhoto ? "rgba(255,255,255,0.2)" : palette.rule,
        borderRadius: 999,
        paddingVertical: 5,
        paddingLeft: 5,
        paddingRight: 12,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <Avatar initials={author.initials} keyStr={author.key} />
      <View style={{ flexShrink: 1, minWidth: 0 }}>
        <Text style={{ fontFamily: font.bodySemi, fontSize: 14, lineHeight: 18, color: ink }}>{author.name}</Text>
        {author.headline && (
          <Text numberOfLines={1} style={{ fontFamily: font.body, fontSize: 12.5, lineHeight: 16, color: sub }}>
            {author.headline}
          </Text>
        )}
      </View>
      <PagerIcon name="chevron-right" size={16} color={onPhoto ? "rgba(255,255,255,0.8)" : palette.muted} />
    </Pressable>
  );
}

/** The reader's author card (.acard): avatar, name, role, one line, stats, "More about X ›". */
export function AuthorCardView({ author, onMore }: { author: Author; onMore: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`About the author, ${author.name}`}
      onPress={onMore}
      style={({ pressed }) => ({
        gap: 12,
        backgroundColor: palette.panel,
        borderWidth: 1,
        borderColor: palette.rule,
        borderRadius: 20,
        padding: 14,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Avatar initials={author.initials} keyStr={author.key} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: font.bodySemi, fontSize: 16, color: palette.ink }}>{author.name}</Text>
          {author.role && <Text style={{ fontFamily: font.body, fontSize: 13.5, color: palette.muted }}>{author.role}</Text>}
        </View>
      </View>
      {author.short && <Text style={{ fontFamily: font.body, fontSize: 15, lineHeight: 22.5, color: palette.promptInk }}>{author.short}</Text>}
      <Stats stats={author.stats} tile={palette.surface} />
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={{ fontFamily: font.bodySemi, fontSize: 14, color: palette.blue }}>More about {firstName(author.name)}</Text>
        <PagerIcon name="chevron-right" size={16} color={palette.blue} />
      </View>
    </Pressable>
  );
}

/** The author dialog (.adlg). Sections without data are left out: a card can be just a name. */
export function AuthorSheet({ author: base, onClose }: { author: Author | null; onClose: () => void }) {
  useLocalVersion();
  const follow = useFollowAuthor();
  const author = base ? authorWithLocal(base) : null;

  return (
    <Sheet open={!!author} onClose={onClose} label={author?.name ?? "Author"} z={45}>
      {author && (
        <>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 14 }}>
            <Avatar initials={author.initials} keyStr={author.key} size={64} />
            <View style={{ flex: 1 }}>
              <Display size={26} lineHeight={29}>
                {author.name}
              </Display>
              {author.role && <Text style={{ fontFamily: font.body, fontSize: 14, color: palette.muted }}>{author.role}</Text>}
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close"
              onPress={onClose}
              style={{ width: 44, height: 44, borderRadius: 22, borderWidth: 1.5, borderColor: palette.lineSoft, alignItems: "center", justifyContent: "center" }}
            >
              <PagerIcon name="close" color={palette.ink} />
            </Pressable>
          </View>
          {(author.bio ?? author.short) && <Text style={{ fontFamily: font.body, fontSize: 16, lineHeight: 24.8, color: palette.ink }}>{author.bio ?? author.short}</Text>}
          <Stats stats={author.stats} tile={palette.panel} />
          {author.knownFor.length > 0 && (
            <>
              <Mono>Known for</Mono>
              <View style={{ gap: 8 }}>
                {author.knownFor.map((k) => (
                  <View key={k} style={{ flexDirection: "row", gap: 10 }}>
                    <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: palette.blue, marginTop: 8 }} />
                    <Text style={{ flex: 1, fontFamily: font.body, fontSize: 15, lineHeight: 21.75, color: palette.ink }}>{k}</Text>
                  </View>
                ))}
              </View>
            </>
          )}
          {author.yourReading.length > 0 && (
            <>
              <Mono>In your reading</Mono>
              {author.yourReading.map((y) => (
                <Pressable
                  key={y.itemId}
                  accessibilityRole="link"
                  onPress={() => {
                    onClose();
                    router.push({ pathname: "/items/[id]", params: { id: y.itemId } });
                  }}
                  style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 12, borderWidth: 1, borderColor: palette.rule, borderRadius: 16, padding: 12, opacity: pressed ? 0.7 : 1 })}
                >
                  <PagerIcon name="doc" color={palette.blue} />
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontFamily: font.bodySemi, fontSize: 15, color: palette.ink }}>{y.title}</Text>
                    <Text style={{ fontFamily: font.body, fontSize: 13, color: palette.muted }}>{y.note}</Text>
                  </View>
                </Pressable>
              ))}
            </>
          )}
          <View style={{ flexDirection: "row", gap: 8 }}>
            <SheetButton
              title={author.following ? "Following ✓" : `Follow ${firstName(author.name)}`}
              primary={!author.following}
              selected={author.following}
              onPress={() => follow.mutate({ key: author.key, following: !author.following })}
            />
            {author.siteUrl && <SheetButton title="Their site" icon onPress={() => void Linking.openURL(author.siteUrl!)} />}
          </View>
          {follow.isError && (
            <Text accessibilityRole="alert" style={{ fontFamily: font.body, fontSize: 13, color: palette.no }}>
              Couldn&apos;t update that. Try again.
            </Text>
          )}
          {author.provenance && <Text style={{ fontFamily: font.body, fontSize: 12.5, lineHeight: 18, color: palette.offText }}>{author.provenance}</Text>}
        </>
      )}
    </Sheet>
  );
}

/** .btn.pri / .btn.sec, pill-shaped, as in the dialogs. */
export function SheetButton({ title, primary, onPress, icon, selected }: { title: string; primary?: boolean; onPress: () => void; icon?: boolean; selected?: boolean }) {
  return (
    <Pressable
      accessibilityRole="button"
      aria-pressed={selected}
      onPress={onPress}
      style={({ pressed }) => ({
        flex: 1,
        minHeight: 52,
        borderRadius: 999,
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        paddingHorizontal: 22,
        backgroundColor: primary ? palette.blue : palette.surface,
        borderWidth: primary ? 0 : 1.5,
        borderColor: palette.lineSoft,
        opacity: pressed ? 0.88 : 1,
      })}
    >
      <Text style={{ fontFamily: font.bodySemi, fontSize: 16, color: primary ? "#FFFFFF" : palette.ink }}>{title}</Text>
      {icon && <PagerIcon name="external" size={16} color={palette.ink} />}
    </Pressable>
  );
}
