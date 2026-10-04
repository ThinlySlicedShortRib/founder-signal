import { View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";

/** The pager boards' stroke icons (24×24, round caps and joins), path for path. Decorative. */
export type PagerIconName =
  | "up"
  | "down"
  | "menu"
  | "close"
  | "bookmark"
  | "dots"
  | "chevron-down"
  | "chevron-right"
  | "chevron-left"
  | "external"
  | "share"
  | "doc"
  | "play"
  | "check"
  | "arrow-right"
  | "plus";

const PATHS: Record<Exclude<PagerIconName, "dots" | "play">, string[]> = {
  up: ["M12 19V5M6 11l6-6 6 6"],
  down: ["M12 5v14M6 13l6 6 6-6"],
  menu: ["M5 9h14M5 15h14"],
  close: ["M6 6l12 12M18 6L6 18"],
  bookmark: ["M6 3h12v18l-6-4-6 4z"],
  "chevron-down": ["M6 9l6 6 6-6"],
  "chevron-right": ["M9 5l7 7-7 7"],
  "chevron-left": ["M15 5l-7 7 7 7"],
  external: ["M14 4h6v6M20 4l-9 9", "M18 14v6H4V6h6"],
  share: ["M12 3v12M7 8l5-5 5 5", "M5 13v7h14v-7"],
  doc: ["M6 3h9l4 4v14H6z", "M14 3v5h5M9 13h7M9 17h5"],
  check: ["M5 12l5 5L20 7"],
  "arrow-right": ["M5 12h14M13 6l6 6-6 6"],
  plus: ["M12 5v14M5 12h14"],
};

export function PagerIcon({
  name,
  size = 20,
  color,
  strokeWidth = 2,
  filled,
}: {
  name: PagerIconName;
  size?: number;
  color: string;
  strokeWidth?: number;
  /** The bookmark when saved. */
  filled?: boolean;
}) {
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ pointerEvents: "none" }}>
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        {name === "dots" ? (
          <>
            <Circle cx={5} cy={12} r={2} fill={color} />
            <Circle cx={12} cy={12} r={2} fill={color} />
            <Circle cx={19} cy={12} r={2} fill={color} />
          </>
        ) : name === "play" ? (
          <Path d="M8 5v14l11-7z" fill={color} stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
        ) : (
          PATHS[name].map((d) => (
            <Path
              key={d}
              d={d}
              stroke={color}
              strokeWidth={strokeWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
              fill={filled ? color : "none"}
            />
          ))
        )}
      </Svg>
    </View>
  );
}

/** The reading pill's progress ring: 26px, 4px track, blue arc from 12 o'clock. */
export function ProgressRing({ progress, size = 26 }: { progress: number; size?: number }) {
  const r = 15;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, progress));
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={{ pointerEvents: "none" }}>
      <Svg width={size} height={size} viewBox="0 0 36 36">
        <Circle cx={18} cy={18} r={r} fill="none" stroke="rgba(255,255,255,0.2)" strokeWidth={4} />
        {p > 0 && (
          <Circle
            cx={18}
            cy={18}
            r={r}
            fill="none"
            stroke="#2B4BFF"
            strokeWidth={4}
            strokeLinecap="round"
            strokeDasharray={`${c * p} ${c}`}
            transform="rotate(-90 18 18)"
          />
        )}
      </Svg>
    </View>
  );
}
