import { Fragment } from "react";
import { Pressable, Text, View } from "react-native";
import { em, font, usePalette } from "./kit";

export interface Clause {
  key: string;
  /** Text before the blank, e.g. " Lately I've been into ". */
  lead: string;
  /** The answer, or null while it's the blank being asked. */
  answer: string | null;
  onEdit: () => void;
}

// .brief: Bricolage 500, 21px, line-height 1.42, -0.015em.
const SIZE = 21;
const LINE = SIZE * 1.42;
const brief = { fontFamily: font.displayMedium, fontSize: SIZE, lineHeight: LINE, letterSpacing: em(-0.015, SIZE) };
// .ans: 700, line-height 1.2, a 3px bottom border, 2px side padding.
const ANS_LINE = SIZE * 1.2;
const UNDERLINE = 3;
// Keeps the answer's baseline level with the plain words around it.
const ANS_TOP = (LINE - ANS_LINE) / 2;

/**
 * "I'm a ___. Lately I've been into ___. …" (design .brief). Answered blanks
 * are blue with a thick underline and tap to change; the current blank is an
 * orange underline. Text can't draw a 3px underline, so the sentence is laid
 * out word by word and each answer word carries its own border; the space
 * after a word sits inside it so the line runs on unbroken.
 */
export function Sentence({ clauses }: { clauses: Clause[] }) {
  const p = usePalette();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "flex-start" }} accessibilityRole="text">
      {clauses.map((c) => {
        const lead = words(c.lead);
        return (
          <Fragment key={c.key}>
            {lead.map((w, i) => (
              <Text key={`${c.key}-l${i}`} style={[brief, { color: p.ink }]}>
                {w}
              </Text>
            ))}
            {c.answer !== null ? (
              <Answer text={c.answer} onPress={c.onEdit} color={p.blue} ink={p.ink} />
            ) : (
              <View style={{ flexDirection: "row" }} accessibilityLabel="blank">
                <View style={{ minWidth: 80, height: ANS_LINE + UNDERLINE, marginTop: ANS_TOP, borderBottomWidth: UNDERLINE, borderBottomColor: p.blank }} />
                <Text style={[brief, { color: p.ink }]}>.</Text>
              </View>
            )}
          </Fragment>
        );
      })}
    </View>
  );
}

/** Each word with the spaces after it. */
function words(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [];
}

function Answer({ text, onPress, color, ink }: { text: string; onPress: () => void; color: string; ink: string }) {
  const parts = words(text);
  return (
    <>
      {parts.map((w, i) => {
        const first = i === 0;
        const last = i === parts.length - 1;
        const word = (
          <Pressable
            onPress={onPress}
            // One stop for screen readers: the first word speaks for the whole answer.
            accessible={first}
            accessibilityRole={first ? "button" : undefined}
            accessibilityLabel={first ? text : undefined}
            accessibilityHint={first ? "Change this answer" : undefined}
            importantForAccessibility={first ? "yes" : "no-hide-descendants"}
            style={{ marginTop: ANS_TOP, borderBottomWidth: UNDERLINE, borderBottomColor: color, paddingLeft: first ? 2 : 0, paddingRight: last ? 2 : 0 }}
          >
            <Text style={[brief, { fontFamily: font.display, lineHeight: ANS_LINE, color }]}>{w}</Text>
          </Pressable>
        );
        // The full stop stays on the line with the answer's last word.
        return last ? (
          <View key={i} style={{ flexDirection: "row" }}>
            {word}
            <Text style={[brief, { color: ink }]}>.</Text>
          </View>
        ) : (
          <Fragment key={i}>{word}</Fragment>
        );
      })}
    </>
  );
}
