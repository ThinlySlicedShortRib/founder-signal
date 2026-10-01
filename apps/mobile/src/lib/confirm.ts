import { Alert, Platform } from "react-native";

/** A destructive confirmation that works on web too (Alert buttons don't). */
export function confirm({ title, message, confirmLabel }: { title: string; message: string; confirmLabel: string }): Promise<boolean> {
  if (Platform.OS === "web") return Promise.resolve(window.confirm(`${title}\n\n${message}`));
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      { text: confirmLabel, style: "destructive", onPress: () => resolve(true) },
    ]),
  );
}
