import { QueryClientProvider } from "@tanstack/react-query";
import { useFonts } from "expo-font";
import { type ErrorBoundaryProps, Stack, usePathname } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { ActivityIndicator, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { font, ONBOARDING_FONTS, palette } from "@/components/onboarding/kit";
import { Body, Button, Screen, Title } from "@/components/ui";
import { authClient } from "@/lib/auth";
import { installGlobalErrorHandlers, reportError, setErrorContext } from "@/lib/error-reporting";
import { useProfile } from "@/lib/profile";
import { queryClient } from "@/lib/query";

installGlobalErrorHandlers();

/** Render errors anywhere below the root land here (and in CloudWatch). */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  useEffect(() => reportError(error, { fatal: true }), [error]);
  return (
    <Screen edges="both">
      <Title>Something went wrong</Title>
      <Body muted>The problem has been reported. Try again, and if it keeps happening, restart the app.</Body>
      <Button title="Try again" onPress={retry} />
    </Screen>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <AppStack />
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

/** Layout 6 has no tab bar: Today, Library, Activity and Preferences are reached from the pill's menu. */
const PAGER = { headerShown: false, animation: "fade" as const };

function AppStack() {
  const { data: session, isPending } = authClient.useSession();
  const pathname = usePathname();
  useEffect(() => setErrorContext(pathname), [pathname]);
  const signedIn = !!session;
  const profile = useProfile({ enabled: signedIn });
  // Text falls back to the system font if these fail; don't hold the app on them.
  const [fontsLoaded, fontError] = useFonts(ONBOARDING_FONTS);

  if (isPending || (signedIn && profile.isPending) || (!fontsLoaded && !fontError)) {
    return (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: palette.ground }}>
        <ActivityIndicator color={palette.muted} accessibilityLabel="Loading" />
      </View>
    );
  }

  // A new account goes through onboarding first. If the profile can't load
  // (offline), the app opens rather than trapping the user on a setup screen.
  const onboarded = !!profile.data?.onboardedAt || (profile.isError && !profile.data);
  return (
    <>
      <StatusBar style="dark" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: palette.ground },
          headerTintColor: palette.ink,
          headerTitleStyle: { fontFamily: font.display, fontSize: 18, color: palette.ink },
          headerBackButtonDisplayMode: "minimal",
          headerShadowVisible: false,
          contentStyle: { backgroundColor: palette.ground },
        }}
      >
        <Stack.Protected guard={signedIn && onboarded}>
          <Stack.Screen name="index" options={PAGER} />
          <Stack.Screen name="library" options={PAGER} />
          <Stack.Screen name="activity" options={PAGER} />
          <Stack.Screen name="preferences" options={PAGER} />
          <Stack.Screen name="letters/[id]" options={{ headerShown: false }} />
          <Stack.Screen name="items/[id]" options={{ headerShown: false }} />
          <Stack.Screen name="sources/index" options={{ title: "Sources" }} />
          <Stack.Screen name="sources/add" options={{ title: "Add a source", presentation: "modal" }} />
          <Stack.Screen name="sources/[id]" options={{ title: "Source" }} />
          <Stack.Screen name="sources/import/index" options={{ title: "Import what you follow" }} />
          <Stack.Screen name="sources/import/[id]" options={{ title: "Choose what to add" }} />
          <Stack.Screen name="dev" options={PAGER} />
        </Stack.Protected>
        <Stack.Protected guard={signedIn && !onboarded}>
          <Stack.Screen name="onboarding" options={{ headerShown: false, gestureEnabled: false }} />
        </Stack.Protected>
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        </Stack.Protected>
      </Stack>
    </>
  );
}
