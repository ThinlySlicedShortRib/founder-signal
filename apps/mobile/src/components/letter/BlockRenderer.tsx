import type { Block } from "@fs/schema";
import { Image } from "expo-image";
import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { font, palette } from "@/components/onboarding/kit";

/** Reader body text: Standard (.t18) or Large (.t21). */
export const TEXT_SIZES = {
  standard: { fontSize: 18, lineHeight: 29 },
  large: { fontSize: 21, lineHeight: 33.6 },
} as const;
export type TextSize = keyof typeof TEXT_SIZES;

/** Renders extracted article blocks natively, in the reader's type. */
export function BlockView({ block, size }: { block: Block; size: TextSize }) {
  const t = TEXT_SIZES[size];
  const body = { fontFamily: font.body, color: palette.ink, ...t };
  switch (block.type) {
    case "heading": {
      // .rsh for h1–h2; smaller levels step down.
      const fs = block.level <= 2 ? 24 : block.level === 3 ? 20 : 18;
      return (
        <Text accessibilityRole="header" style={{ marginTop: 10, fontFamily: font.display, fontSize: fs, lineHeight: fs * 1.2, letterSpacing: -0.02 * fs, color: palette.ink }}>
          {block.text}
        </Text>
      );
    }
    case "paragraph":
      return <Text style={body}>{block.text}</Text>;
    case "quote":
      return (
        <View style={{ borderLeftWidth: 3, borderLeftColor: palette.blue, paddingLeft: 14 }}>
          <Text style={{ ...body, fontFamily: font.displayMedium, fontSize: t.fontSize + 1, letterSpacing: -0.2, color: palette.promptInk }}>{block.text}</Text>
        </View>
      );
    case "list":
      return (
        <View style={{ gap: 8 }} accessibilityRole="list">
          {block.items.map((item, i) => (
            <View key={i} style={{ flexDirection: "row", gap: 10 }}>
              {block.ordered ? (
                <Text style={{ ...body, minWidth: 22, fontFamily: font.bodySemi, color: palette.blue }}>{i + 1}.</Text>
              ) : (
                <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: palette.blue, marginTop: t.lineHeight / 2 - 3 }} />
              )}
              <Text style={{ ...body, flex: 1 }}>{item}</Text>
            </View>
          ))}
        </View>
      );
    case "image":
      return <BlockImage src={block.src} alt={block.alt} caption={block.caption} />;
    case "caption":
      return <Text style={{ fontFamily: font.body, fontSize: 14, lineHeight: 20, color: palette.muted }}>{block.text}</Text>;
    case "table":
      return <BlockTable header={block.header} rows={block.rows} />;
  }
}

function BlockImage({ src, alt, caption }: { src: string; alt?: string; caption?: string }) {
  const [ratio, setRatio] = useState(16 / 10);
  return (
    <View style={{ gap: 8 }}>
      <Image
        source={{ uri: src }}
        accessibilityLabel={alt ?? caption}
        accessible={!!(alt ?? caption)}
        onLoad={(e) => e.source.width && e.source.height && setRatio(e.source.width / e.source.height)}
        contentFit="cover"
        transition={150}
        style={{ width: "100%", aspectRatio: ratio, borderRadius: 16, backgroundColor: palette.grey }}
      />
      {caption && <Text style={{ fontFamily: font.body, fontSize: 14, lineHeight: 20, color: palette.muted }}>{caption}</Text>}
    </View>
  );
}

/** A table as a card that scrolls sideways when it's wider than the screen. */
function BlockTable({ header, rows }: { header?: string[]; rows: string[][] }) {
  const cols = Math.max(header?.length ?? 0, ...rows.map((r) => r.length));
  const cell = (text: string | undefined, head: boolean, key: number) => (
    <Text
      key={key}
      style={{
        width: 150,
        paddingVertical: 10,
        paddingHorizontal: 12,
        fontFamily: head ? font.bodySemi : font.body,
        fontSize: 14.5,
        lineHeight: 20,
        color: palette.ink,
      }}
    >
      {text ?? ""}
    </Text>
  );
  return (
    <View style={{ borderWidth: 1, borderColor: palette.rule, borderRadius: 16, overflow: "hidden", backgroundColor: palette.surface }}>
      <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ flexDirection: "column" }}>
        {header && (
          <View style={{ flexDirection: "row", backgroundColor: palette.panel, borderBottomWidth: 1, borderBottomColor: palette.rule }}>
            {Array.from({ length: cols }, (_, i) => cell(header[i], true, i))}
          </View>
        )}
        {rows.map((r, ri) => (
          <View key={ri} style={{ flexDirection: "row", borderTopWidth: ri ? 1 : 0, borderTopColor: palette.rule }}>
            {Array.from({ length: cols }, (_, i) => cell(r[i], false, i))}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}
