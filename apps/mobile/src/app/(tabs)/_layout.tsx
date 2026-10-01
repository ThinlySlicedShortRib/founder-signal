import Ionicons from "@expo/vector-icons/Ionicons";
import { Tabs } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { IconName } from "@/components/ui";
import { serif, useColors } from "@/lib/theme";

const TABS: { name: string; title: string; icon: IconName; iconActive: IconName }[] = [
  { name: "index", title: "Today", icon: "mail-open-outline", iconActive: "mail-open" },
  { name: "library", title: "Library", icon: "bookmarks-outline", iconActive: "bookmarks" },
  { name: "activity", title: "Activity", icon: "calendar-outline", iconActive: "calendar" },
  { name: "preferences", title: "Preferences", icon: "options-outline", iconActive: "options" },
];

export default function TabLayout() {
  const c = useColors();
  const insets = useSafeAreaInsets();
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: c.accent,
        tabBarInactiveTintColor: c.textMuted,
        // Sized explicitly so the labels' descenders (Today, Library) aren't clipped,
        // with the home-indicator inset below.
        tabBarStyle: {
          backgroundColor: c.surface,
          borderTopColor: c.border,
          height: 60 + insets.bottom,
          paddingTop: 6,
          paddingBottom: insets.bottom + 6,
        },
        tabBarLabelStyle: { fontSize: 12, lineHeight: 16, flexShrink: 0 },
        headerStyle: { backgroundColor: c.background },
        headerTitleStyle: { fontFamily: serif, color: c.text },
        headerShadowVisible: false,
        sceneStyle: { backgroundColor: c.background },
      }}
    >
      {TABS.map((t) => (
        <Tabs.Screen
          key={t.name}
          name={t.name}
          options={{
            title: t.title,
            // Today's greeting is its own title.
            headerShown: t.name !== "index",
            tabBarAccessibilityLabel: t.title,
            tabBarIcon: ({ color, focused }) => <Ionicons name={focused ? t.iconActive : t.icon} size={24} color={color} />,
          }}
        />
      ))}
    </Tabs>
  );
}
