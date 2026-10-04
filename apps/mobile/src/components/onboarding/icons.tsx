import type { ReactNode } from "react";
import { View } from "react-native";
import Svg, { Circle, Path, Rect } from "react-native-svg";

/** Decorative: hidden from screen readers (on the wrapper, since web SVG rejects these props). */
function Hidden({ children }: { children: ReactNode }) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {children}
    </View>
  );
}

/** The board's inline stroke icons (24×24, round caps and joins), path for path. */
export type BoardIconName = "envelope" | "note" | "pencil" | "sort" | "shield" | "stamp" | "truck" | "article" | "video" | "check" | "x" | "chevron-left";

export function BoardIcon({ name, size = 16, color, strokeWidth = 2 }: { name: BoardIconName; size?: number; color: string; strokeWidth?: number }) {
  const stroke = {
    stroke: color,
    strokeWidth,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    fill: "none",
  };
  return (
    <Hidden>
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        {name === "envelope" && (
          <>
            <Rect x={3} y={5} width={18} height={14} rx={2} {...stroke} />
            <Path d="M3 7l9 6 9-6" {...stroke} />
          </>
        )}
        {(name === "note" || name === "article") && (
          <>
            <Path d="M6 3h9l4 4v14H6z" {...stroke} />
            <Path d="M14 3v5h5M9 13h7M9 17h5" {...stroke} />
          </>
        )}
        {name === "pencil" && (
          <>
            <Path d="M4 20l4-1 11-11-3-3L5 16l-1 4z" {...stroke} />
            <Path d="M14 6l3 3" {...stroke} />
          </>
        )}
        {name === "sort" && (
          <>
            <Path d="M4 13l2-7h12l2 7" {...stroke} />
            <Path d="M4 13v5h16v-5h-5l-1 2h-4l-1-2H4z" {...stroke} />
          </>
        )}
        {name === "shield" && (
          <>
            <Path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" {...stroke} />
            <Path d="M9 12l2 2 4-4" {...stroke} />
          </>
        )}
        {name === "stamp" && (
          <>
            <Path d="M9 4h6v4l3 2v4H6v-4l3-2V4z" {...stroke} />
            <Path d="M5 18h14v2H5z" {...stroke} />
          </>
        )}
        {name === "truck" && (
          <>
            <Path d="M2 6h11v10H2z" {...stroke} />
            <Path d="M13 9h4l4 4v3h-8" {...stroke} />
            <Circle cx={6} cy={18} r={2} {...stroke} />
            <Circle cx={17} cy={18} r={2} {...stroke} />
          </>
        )}
        {name === "video" && (
          <>
            <Rect x={3} y={6} width={13} height={12} rx={2} {...stroke} />
            <Path d="M16 10l5-3v10l-5-3z" {...stroke} />
          </>
        )}
        {name === "check" && <Path d="M5 12l5 5L20 7" {...stroke} />}
        {name === "x" && <Path d="M6 6l12 12M18 6L6 18" {...stroke} />}
        {name === "chevron-left" && <Path d="M15 18l-6-6 6-6" {...stroke} />}
      </Svg>
    </Hidden>
  );
}

/** The dropped-lines notice uses the shield outline without the tick. */
export function ShieldOutline({ size = 16, color }: { size?: number; color: string }) {
  return (
    <Hidden>
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <Path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
      </Svg>
    </Hidden>
  );
}
